import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ActivityRecord,
  ConversationMessageRecord,
  ConversationResponse,
  DecisionRecord,
  DecisionsResponse,
  DirectorNoteRecord,
  DirectorOperationResponse,
  DirectorStatusResponse,
  ExecutionMode,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  HumanQuestionRecord,
  InitCommandOptions,
  IssueOwnershipRecord,
  LaneRecord,
  OrchestratorStatusRecord,
  PrCycleRecord,
  ProjectRecord,
  RunRecord,
  SetupCheck,
  SetupCheckKind,
  SetupProblemCode,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse,
  WorkItemKind,
  WorkItemRecord,
  WorkItemStatus
} from "@director-os/shared";

import { probeCodexCli, runCodexSessionAgent } from "./agents.js";
import {
  ensureRuntimeDirectories,
  getProjectConfig,
  loadConfig,
  nowIso,
  resolveRuntimePaths,
  saveConfig,
  slugify,
  type DirectorConfigFile,
  type RuntimePaths,
  type StoredProjectConfig,
  upsertProjectConfig
} from "./config.js";
import { COS_TASK_APPENDICES, buildChiefOfStaffPrompt } from "./cos.js";
import {
  detectRepoFromPath,
  ensureGhAuthenticated,
  fetchRepoDetails,
  listComments,
  listIssues,
  listPullRequests,
  probeGhCli,
  probeRepositoryPath,
  resolveRepoPath
} from "./github.js";
import {
  createDefaultConversationState,
  initializeProjectRuntime,
  loadConversationState,
  loadGitHubCacheState,
  loadRouterState,
  saveConversationState,
  saveGitHubCacheState,
  saveRouterState,
  type GitHubCacheState,
  type RouterHandoffState,
  type RouterLaneState,
  type RouterQuestionState,
  type RouterState
} from "./runtime-state.js";

const execFileAsync = promisify(execFile);

const LOOP_INTERVAL_MS = 30 * 1000;
const ORCHESTRATOR_OWNER_TOKEN = `${process.pid}:${randomUUID()}`;

let orchestratorTimer: NodeJS.Timeout | null = null;
let orchestratorRunning = false;

type OrchestratorLockRecord = {
  pid: number;
  token: string;
  acquiredAt: string;
};

type RuntimeSession = {
  paths: RuntimePaths;
  config: DirectorConfigFile;
};

type ProjectSession = RuntimeSession & {
  project: ProjectRecord;
  projectConfig: StoredProjectConfig;
};

type CoSChatReply = {
  kind: "cos_reply" | "cos_question";
  reply: string;
  question: string | null;
  recommendation: string | null;
  rationale: string | null;
  run: RunRecord;
};

function assertPresent<TValue>(value: TValue | null | undefined, message: string): TValue {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

function summarizeText(value: string, maxLength = 240): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function parseDataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapAgentStatusToRunStatus(status: "ok" | "needs_input" | "failed"): RunRecord["status"] {
  switch (status) {
    case "ok":
      return "succeeded";
    case "needs_input":
      return "needs_input";
    case "failed":
    default:
      return "failed";
  }
}

function truncatePromptSection(value: string | null | undefined, maxLength = 8_000): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function setupTitle(kind: SetupCheckKind): string {
  switch (kind) {
    case "repository":
      return "Repository";
    case "github":
      return "GitHub CLI";
    case "codex":
      return "Codex CLI";
    case "workspace":
      return "Workspace";
    default:
      return "Setup";
  }
}

function makeSetupCheck(
  kind: SetupCheckKind,
  status: SetupCheck["status"],
  detail: string,
  options?: {
    code?: SetupProblemCode | null;
    recommendedAction?: string | null;
    advancedDetail?: string | null;
  }
): SetupCheck {
  return {
    kind,
    status,
    title: setupTitle(kind),
    detail,
    code: options?.code ?? null,
    recommendedAction: options?.recommendedAction ?? null,
    advancedDetail: options?.advancedDetail ?? null
  };
}

function waitingSetupCheck(kind: SetupCheckKind, detail: string): SetupCheck {
  return makeSetupCheck(kind, "waiting", detail);
}

function projectFromConfig(projectConfig: StoredProjectConfig): ProjectRecord {
  return {
    id: projectConfig.id,
    name: projectConfig.name,
    slug: projectConfig.slug,
    repoPath: projectConfig.repoPath,
    repoSlug: projectConfig.repoSlug,
    defaultBranch: projectConfig.defaultBranch,
    worktreeRoot: projectConfig.worktreeRoot,
    agentRunner: projectConfig.agentRunner,
    model: projectConfig.model,
    createdAt: projectConfig.createdAt,
    updatedAt: projectConfig.updatedAt
  };
}

function projectToSetupDraft(project: ProjectRecord): SetupRepositoryDraft {
  return {
    repoPath: project.repoPath,
    projectName: project.name,
    repoSlug: project.repoSlug,
    defaultBranch: project.defaultBranch,
    worktreeRoot: project.worktreeRoot,
    agentRunner: project.agentRunner,
    model: project.model
  };
}

function draftToStoredProjectConfig(
  config: DirectorConfigFile,
  draft: SetupRepositoryDraft
): StoredProjectConfig {
  const slug = slugify(draft.projectName);
  const existing = config.projects.find((candidate) => candidate.slug === slug);
  const timestamp = nowIso();

  return {
    id:
      existing?.id ??
      (config.projects.reduce((maxId, candidate) => Math.max(maxId, candidate.id), 0) + 1),
    name: draft.projectName,
    slug,
    repoPath: draft.repoPath,
    repoSlug: draft.repoSlug,
    defaultBranch: draft.defaultBranch,
    worktreeRoot: draft.worktreeRoot,
    agentRunner: draft.agentRunner,
    createdAt: existing?.createdAt ?? timestamp,
    model: draft.model,
    updatedAt: timestamp
  };
}

async function withRuntime<TValue>(
  callback: (session: RuntimeSession) => Promise<TValue>
): Promise<TValue> {
  const paths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const config = await loadConfig(paths);
  return callback({
    paths,
    config
  });
}

async function withProject<TValue>(
  callback: (session: ProjectSession) => Promise<TValue>
): Promise<TValue> {
  return withRuntime(async (session) => {
    const slug = session.config.activeProjectSlug;
    if (!slug) {
      throw new Error("No active project is configured. Run `director init` first.");
    }

    const projectConfig = getProjectConfig(session.config, slug);
    if (!projectConfig) {
      throw new Error(`The active project '${slug}' is missing from config.json.`);
    }

    await initializeProjectRuntime(session.paths, projectConfig);

    return callback({
      ...session,
      project: projectFromConfig(projectConfig),
      projectConfig
    });
  });
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });

  return result.stdout.trim();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readOrchestratorLock(paths: RuntimePaths): Promise<OrchestratorLockRecord | null> {
  try {
    const raw = await fs.readFile(paths.orchestratorLockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorLockRecord>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return {
        pid: parsed.pid,
        token: parsed.token,
        acquiredAt: parsed.acquiredAt
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
  }

  return null;
}

async function writeOrchestratorLock(paths: RuntimePaths): Promise<void> {
  await fs.writeFile(
    paths.orchestratorLockPath,
    `${JSON.stringify(
      {
        pid: process.pid,
        token: ORCHESTRATOR_OWNER_TOKEN,
        acquiredAt: nowIso()
      } satisfies OrchestratorLockRecord,
      null,
      2
    )}\n`,
    {
      encoding: "utf8",
      flag: "wx"
    }
  );
}

async function acquireOrchestratorLock(
  paths: RuntimePaths
): Promise<"owned" | "acquired" | "busy"> {
  const current = await readOrchestratorLock(paths);
  if (current?.token === ORCHESTRATOR_OWNER_TOKEN) {
    return "owned";
  }

  try {
    await writeOrchestratorLock(paths);
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readOrchestratorLock(paths);
  if (existing?.token === ORCHESTRATOR_OWNER_TOKEN) {
    return "owned";
  }

  if (existing && isProcessAlive(existing.pid)) {
    return "busy";
  }

  try {
    await fs.unlink(paths.orchestratorLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await writeOrchestratorLock(paths);
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "busy";
    }
    throw error;
  }
}

async function releaseOrchestratorLock(paths: RuntimePaths): Promise<void> {
  const current = await readOrchestratorLock(paths);
  if (current?.token !== ORCHESTRATOR_OWNER_TOKEN) {
    return;
  }

  try {
    await fs.unlink(paths.orchestratorLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function getActiveProjectFromRuntime(session: RuntimeSession): Promise<ProjectRecord | null> {
  const activeProjectConfig = getProjectConfig(session.config, session.config.activeProjectSlug);
  return activeProjectConfig ? projectFromConfig(activeProjectConfig) : null;
}

async function buildRepositoryDraft(
  input: SetupProbeRepositoryInput,
  paths: RuntimePaths
): Promise<{
  draft: SetupRepositoryDraft | null;
  repositoryCheck: SetupCheck;
}> {
  const rawPath = input.repoPath?.trim();

  if (!rawPath) {
    return {
      draft: null,
      repositoryCheck: makeSetupCheck("repository", "needs_action", "Choose the repository Director OS should operate on.", {
        code: "repo_missing",
        recommendedAction: "Enter the absolute path to a local repository."
      })
    };
  }

  if (!path.isAbsolute(rawPath)) {
    return {
      draft: null,
      repositoryCheck: makeSetupCheck("repository", "needs_action", "Repository path must be absolute.", {
        code: "repo_not_absolute",
        recommendedAction: "Use the full local path, starting with `/`."
      })
    };
  }

  try {
    const resolvedRepo = resolveRepoPath(rawPath);
    const probed = await probeRepositoryPath(resolvedRepo);
    const projectName = input.projectName?.trim() || probed.name || path.basename(resolvedRepo);

    return {
      draft: {
        repoPath: resolvedRepo,
        projectName,
        repoSlug: probed.repoSlug,
        defaultBranch: probed.defaultBranch || "main",
        worktreeRoot:
          input.worktreeRoot?.trim() || path.join(paths.worktreesDir, slugify(projectName)),
        agentRunner: "codex",
        model: input.model?.trim() || "gpt-5.4"
      },
      repositoryCheck: makeSetupCheck("repository", "ready", `Using ${resolvedRepo}.`)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      draft: null,
      repositoryCheck: makeSetupCheck("repository", "blocked", message, {
        code: /ENOENT/.test(message) ? "repo_not_found" : "repo_not_git",
        recommendedAction: "Point Director OS at a local Git repository."
      })
    };
  }
}

async function buildWorkspaceCheck(
  repositoryDraft: SetupRepositoryDraft | null,
  runWorkspace: boolean
): Promise<SetupCheck> {
  if (!repositoryDraft) {
    return waitingSetupCheck("workspace", "Probe a repository before testing workspace access.");
  }

  if (!runWorkspace) {
    return waitingSetupCheck("workspace", "Workspace test has not run yet.");
  }

  try {
    await fs.mkdir(repositoryDraft.worktreeRoot, { recursive: true });
    await fs.access(repositoryDraft.repoPath);
    return makeSetupCheck(
      "workspace",
      "ready",
      `Worktree root is writable at ${repositoryDraft.worktreeRoot}.`
    );
  } catch (error) {
    return makeSetupCheck("workspace", "blocked", error instanceof Error ? error.message : String(error), {
      code: "workspace_probe_failed",
      recommendedAction: "Choose a writable worktree root."
    });
  }
}

async function evaluateSetupState(
  session: RuntimeSession,
  input: {
    activeProject: ProjectRecord | null;
    repositoryDraft: SetupRepositoryDraft | null;
    repositoryCheck?: SetupCheck;
    runWorkspace: boolean;
  }
): Promise<SetupStatusResponse> {
  const repositoryCheck =
    input.repositoryCheck ??
    (input.repositoryDraft
      ? makeSetupCheck("repository", "ready", `Using ${input.repositoryDraft.repoPath}.`)
      : makeSetupCheck("repository", "needs_action", "Choose a Git repository to initialize Director OS.", {
          code: "repo_missing",
          recommendedAction: "Provide an absolute repository path."
        }));

  const [ghProbe, codexProbe, workspaceCheck] = await Promise.all([
    probeGhCli(),
    probeCodexCli(input.repositoryDraft?.model ?? "gpt-5.4-mini"),
    buildWorkspaceCheck(input.repositoryDraft, input.runWorkspace)
  ]);

  const ghCheck = ghProbe.ok
    ? makeSetupCheck("github", "ready", ghProbe.detail)
    : makeSetupCheck(
        "github",
        ghProbe.reason === "auth_required" ? "needs_action" : "blocked",
        ghProbe.detail,
        {
          code:
            ghProbe.reason === "missing"
              ? "gh_missing"
              : ghProbe.reason === "auth_required"
                ? "gh_auth_required"
                : "gh_probe_failed",
          recommendedAction:
            ghProbe.reason === "missing"
              ? "Install the GitHub CLI."
              : ghProbe.reason === "auth_required"
                ? "Run `gh auth login`."
                : null,
          advancedDetail: ghProbe.advancedDetail ?? null
        }
      );

  const codexCheck = codexProbe.ok
    ? makeSetupCheck("codex", "ready", codexProbe.detail)
    : makeSetupCheck(
        "codex",
        codexProbe.reason === "auth_required" ? "needs_action" : "blocked",
        codexProbe.detail,
        {
          code:
            codexProbe.reason === "missing"
              ? "codex_missing"
              : codexProbe.reason === "auth_required"
                ? "codex_sign_in_required"
                : "codex_probe_failed",
          recommendedAction:
            codexProbe.reason === "missing"
              ? "Install Codex CLI."
              : codexProbe.reason === "auth_required"
                ? "Sign in to Codex."
                : null,
          advancedDetail: codexProbe.advancedDetail ?? null
        }
      );

  const checks = [repositoryCheck, ghCheck, codexCheck, workspaceCheck];
  const canComplete =
    Boolean(input.repositoryDraft) && checks.every((check) => check.status === "ready");

  return {
    activeProject: input.activeProject,
    checks,
    repositoryDraft: input.repositoryDraft,
    canComplete,
    completed: Boolean(input.activeProject) && canComplete
  };
}

async function persistProjectRegistration(
  session: RuntimeSession,
  repositoryDraft: SetupRepositoryDraft
): Promise<ProjectRecord> {
  const storedProject = draftToStoredProjectConfig(session.config, repositoryDraft);
  const nextConfig = upsertProjectConfig(session.config, storedProject);
  nextConfig.activeProjectSlug = storedProject.slug;
  await saveConfig(nextConfig, session.paths);
  await initializeProjectRuntime(session.paths, storedProject);
  return projectFromConfig(storedProject);
}

function mapRemoteIssue(project: ProjectRecord, issue: GitHubCacheState["issues"][number]): GitHubIssueRecord {
  const workflowState =
    issue.state.toLowerCase() !== "open"
      ? "done"
      : issue.labels.includes("director:ready")
        ? "ready"
        : issue.labels.includes("director:blocked")
          ? "blocked"
          : issue.labels.includes("director:in-review")
            ? "in_review"
            : "queued";

  return {
    id: issue.number,
    projectId: project.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    workflowState,
    labels: issue.labels,
    url: issue.url,
    updatedAt: issue.updatedAt,
    syncedAt: issue.updatedAt
  };
}

function mapRemotePullRequest(
  project: ProjectRecord,
  pullRequest: GitHubCacheState["pullRequests"][number],
  syncedAt: string | null
): GitHubPullRequestRecord {
  return {
    id: pullRequest.number,
    projectId: project.id,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    reviewDecision: pullRequest.reviewDecision,
    checksBucket: pullRequest.checksBucket,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    url: pullRequest.url,
    linkedIssueNumbers: pullRequest.linkedIssueNumbers,
    updatedAt: pullRequest.updatedAt,
    syncedAt: syncedAt ?? pullRequest.updatedAt
  };
}

function findIssueLane(router: RouterState, issueNumber: number): RouterState["lanes"][number] | null {
  return router.lanes.find((lane) => lane.issueNumbers.includes(issueNumber)) ?? null;
}

function findLaneById(router: RouterState, laneId: string): RouterLaneState | null {
  return router.lanes.find((lane) => lane.id === laneId) ?? null;
}

function ensureLane(router: RouterState, laneId: string, laneName: string): RouterLaneState {
  const existing = findLaneById(router, laneId);
  if (existing) {
    existing.name = existing.name || laneName;
    return existing;
  }

  const lane: RouterLaneState = {
    id: laneId,
    name: laneName,
    sessionId: null,
    issueNumbers: [],
    status: "idle",
    currentIssueNumber: null,
    activePullRequestNumber: null,
    lastSummary: null,
    lastPlanSummary: null,
    updatedAt: nowIso()
  };
  router.lanes.push(lane);
  return lane;
}

function defaultLaneForIssue(issue: GitHubIssueRecord): { id: string; name: string } {
  const explicitLabel = issue.labels.find((label) => label.startsWith("director:lane:"));
  if (explicitLabel) {
    const rawName = explicitLabel.slice("director:lane:".length).trim();
    const normalized = rawName || "delivery";
    return {
      id: slugify(normalized),
      name: normalized
        .split(/[-_\s]+/)
        .map((part) => (part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part))
        .join(" ")
    };
  }

  return {
    id: "delivery",
    name: "Delivery"
  };
}

function defaultExecutionIntentForIssue(issue: GitHubIssueRecord): "plan" | "implement" {
  return issue.labels.includes("director:lane") ? "plan" : "implement";
}

function hasPendingLaneWork(router: RouterState, issueNumber: number): boolean {
  return (
    Boolean(findIssueLane(router, issueNumber)) ||
    router.pendingHandoffs.some(
      (handoff) => handoff.issueNumber === issueNumber && handoff.status === "pending"
    )
  );
}

function enqueueHandoff(
  router: RouterState,
  input: Omit<RouterHandoffState, "id" | "createdAt" | "updatedAt">
): RouterHandoffState {
  const timestamp = nowIso();
  const handoff: RouterHandoffState = {
    id: `handoff_${randomUUID()}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input
  };
  router.pendingHandoffs.push(handoff);
  return handoff;
}

function pendingHandoff(router: RouterState): RouterHandoffState | null {
  return router.pendingHandoffs.find((handoff) => handoff.status === "pending") ?? null;
}

function synthesizeWorkItemStatus(
  issue: GitHubIssueRecord,
  linkedPullRequest: GitHubPullRequestRecord | null,
  router: RouterState
): WorkItemStatus {
  if (issue.state.toLowerCase() !== "open") {
    return "completed";
  }

  if (router.openQuestion?.issueNumber === issue.number) {
    return "waiting_decision";
  }

  if (linkedPullRequest && linkedPullRequest.state.toLowerCase() === "open") {
    return "waiting_review";
  }

  const lane = findIssueLane(router, issue.number);
  if (lane?.status === "blocked") {
    return "blocked";
  }
  if (lane?.status === "planning") {
    return "planning";
  }
  if (lane?.status === "implementing") {
    return "running";
  }
  if (issue.workflowState === "blocked") {
    return "blocked";
  }
  if (issue.workflowState === "ready") {
    return "ready";
  }
  return "queued";
}

function priorityBucketFromStatus(status: WorkItemStatus): number {
  switch (status) {
    case "ready":
      return 0;
    case "planning":
    case "running":
      return 1;
    case "queued":
      return 2;
    case "waiting_review":
    case "waiting_decision":
      return 3;
    case "blocked":
      return 4;
    default:
      return 99;
  }
}

function synthesizeWorkItem(
  project: ProjectRecord,
  issue: GitHubIssueRecord,
  linkedPullRequest: GitHubPullRequestRecord | null,
  router: RouterState
): WorkItemRecord {
  const lane = findIssueLane(router, issue.number);
  const status = synthesizeWorkItemStatus(issue, linkedPullRequest, router);
  const kind: WorkItemKind = issue.labels.includes("director:task") ? "task" : "workstream";
  const executionMode: ExecutionMode = lane ? "lane" : kind === "workstream" ? "lane" : "worker";

  return {
    id: issue.number,
    projectId: project.id,
    issueNumber: issue.number,
    parentIssueNumber: null,
    title: issue.title,
    summary: summarizeText(issue.body || issue.title),
    kind,
    executionMode,
    ownerRole: lane?.name ?? "chief_of_staff",
    status,
    priorityBucket: priorityBucketFromStatus(status),
    activeRunId: null,
    activePrNumber: linkedPullRequest?.number ?? null,
    lastSummary: lane?.lastSummary ?? null,
    createdAt: issue.updatedAt,
    updatedAt: issue.updatedAt
  };
}

function toHumanQuestionRecord(question: RouterQuestionState): HumanQuestionRecord {
  return {
    id: question.id,
    title: question.title,
    question: question.question,
    whyItMatters: question.whyItMatters,
    recommendation: question.recommendation,
    linkedIssueNumber: question.issueNumber,
    linkedPullRequestNumber: question.prNumber,
    createdAt: question.createdAt,
    updatedAt: question.updatedAt
  };
}

function synthesizeLaneRecord(
  lane: RouterState["lanes"][number],
  pullRequests: GitHubPullRequestRecord[]
): LaneRecord {
  const activePullRequest =
    pullRequests.find((pullRequest) =>
      lane.issueNumbers.some((issueNumber) => pullRequest.linkedIssueNumbers.includes(issueNumber))
    ) ?? null;

  return {
    id: lane.id,
    name: lane.name,
    sessionId: lane.sessionId,
    status: lane.status,
    currentIssueNumber: lane.currentIssueNumber,
    ownedIssueNumbers: lane.issueNumbers,
    activePullRequestNumber: activePullRequest?.number ?? lane.activePullRequestNumber,
    lastSummary: lane.lastSummary,
    lastPlanSummary: lane.lastPlanSummary,
    updatedAt: lane.updatedAt
  };
}

function synthesizeIssueOwnership(
  issue: GitHubIssueRecord,
  router: RouterState,
  pullRequests: GitHubPullRequestRecord[]
): IssueOwnershipRecord {
  const lane = findIssueLane(router, issue.number);
  const linkedPullRequest =
    pullRequests.find((pullRequest) => pullRequest.linkedIssueNumbers.includes(issue.number)) ?? null;

  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    workflowState: issue.workflowState,
    laneId: lane?.id ?? null,
    laneName: lane?.name ?? null,
    executionIntent: lane?.status === "planning" ? "plan" : lane ? "implement" : null,
    status:
      issue.state.toLowerCase() !== "open"
        ? "completed"
        : linkedPullRequest
          ? "waiting_review"
          : lane?.status === "blocked"
            ? "blocked"
          : issue.workflowState === "blocked"
            ? "blocked"
            : lane
              ? lane.status === "planning"
                ? "planned"
                : "implementing"
              : "unassigned",
    linkedPullRequestNumber: linkedPullRequest?.number ?? null,
    linkedPullRequestUrl: linkedPullRequest?.url ?? null,
    automationWindowEndsAt: null,
    lastHandledCommentAt: null,
    lastSummary: lane?.lastSummary ?? null,
    updatedAt: issue.updatedAt
  };
}

function synthesizePrCycle(
  project: ProjectRecord,
  pullRequest: GitHubPullRequestRecord
): PrCycleRecord {
  let status: PrCycleRecord["status"] = "opened";

  if (pullRequest.state.toLowerCase() === "merged") {
    status = "merged";
  } else if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
    status = "changes_requested";
  } else if (pullRequest.checksBucket === "pending") {
    status = "waiting_automation";
  } else if (pullRequest.checksBucket === "pass") {
    status = "merge_ready";
  }

  return {
    id: pullRequest.number,
    projectId: project.id,
    issueNumber: pullRequest.linkedIssueNumbers[0] ?? 0,
    prNumber: pullRequest.number,
    status,
    summary: pullRequest.title,
    automationWindowEndsAt: null,
    lastCheckedAt: pullRequest.updatedAt,
    lastHandledCommentAt: null,
    mergedAt: pullRequest.state.toLowerCase() === "merged" ? pullRequest.updatedAt : null,
    createdAt: pullRequest.updatedAt,
    updatedAt: pullRequest.updatedAt
  };
}

function synthesizeActivity(router: RouterState): ActivityRecord[] {
  const noteActivity = router.notes.map<ActivityRecord>((note) => ({
    id: `note_${note.id}`,
    kind: "note",
    summary: note.content,
    laneId: null,
    laneName: null,
    issueNumber: null,
    pullRequestNumber: null,
    createdAt: note.createdAt
  }));

  const runActivity = router.recentRuns.map<ActivityRecord>((run) => ({
    id: `run_${run.id}`,
    kind: run.role,
    summary: run.summary,
    laneId: null,
    laneName: null,
    issueNumber: run.issueNumber,
    pullRequestNumber: run.prNumber,
    createdAt: run.createdAt
  }));

  const questionActivity = router.openQuestion
    ? [
        {
          id: `question_${router.openQuestion.id}`,
          kind: "human_question",
          summary: router.openQuestion.question,
          laneId: null,
          laneName: null,
          issueNumber: router.openQuestion.issueNumber,
          pullRequestNumber: router.openQuestion.prNumber,
          createdAt: router.openQuestion.createdAt
        } satisfies ActivityRecord
      ]
    : [];

  return [...questionActivity, ...runActivity, ...noteActivity]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
}

function synthesizeOrchestratorStatus(
  project: ProjectRecord,
  router: RouterState,
  owner: OrchestratorLockRecord | null
): OrchestratorStatusRecord {
  return {
    id: 1,
    projectId: project.id,
    status: router.orchestrator.status,
    pauseReason: router.orchestrator.pauseReason,
    activeRunIds: [],
    lastLoopAt: router.orchestrator.lastLoopAt,
    lastSummary: router.orchestrator.lastSummary,
    ownerPid: owner?.pid ?? null,
    ownerToken: owner?.token ?? null,
    createdAt: router.updatedAt,
    updatedAt: router.updatedAt
  };
}

function formatHumanQuestionContent(question: string, whyItMatters: string, recommendation: string): string {
  return [
    question.trim(),
    whyItMatters.trim() ? `Why it matters: ${whyItMatters.trim()}` : null,
    recommendation.trim() ? `Recommendation: ${recommendation.trim()}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatResolutionMessage(question: RouterQuestionState, resolution: string): string {
  return [
    `Resolution recorded for: ${question.title}`,
    question.recommendation ? `Chief of Staff recommendation: ${question.recommendation}` : null,
    resolution.trim() ? `Director response: ${resolution.trim()}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function recentConversationPrompt(session: ProjectSession, limit = 10): Promise<string> {
  const conversation = await loadConversationState(session.paths, session.project);
  const messages = conversation.messages.slice(-limit);
  if (!messages.length) {
    return "No prior conversation.";
  }

  return messages.map((message) => `[${message.role}/${message.kind}] ${message.content}`).join("\n");
}

function nextNumericId(values: Array<{ id: number }>): number {
  return values.reduce((max, value) => Math.max(max, value.id), 0) + 1;
}

async function appendConversationMessage(
  session: ProjectSession,
  input: Omit<
    ConversationMessageRecord,
    "id" | "projectId" | "threadId" | "createdAt" | "updatedAt"
  >
): Promise<ConversationMessageRecord> {
  const conversation = await loadConversationState(session.paths, session.project);
  const timestamp = nowIso();
  const threadId = conversation.thread?.id ?? 1;
  const message: ConversationMessageRecord = {
    id: nextNumericId(conversation.messages),
    projectId: session.project.id,
    threadId,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input
  };

  conversation.messages.push(message);
  if (conversation.thread) {
    conversation.thread.projectId = session.project.id;
    conversation.thread.updatedAt = timestamp;
  }
  await saveConversationState(session.paths, conversation, session.project.slug);
  return message;
}

async function getConversationResponse(session: ProjectSession): Promise<ConversationResponse> {
  const [conversation, router] = await Promise.all([
    loadConversationState(session.paths, session.project),
    loadRouterState(session.paths, session.project.slug)
  ]);

  const latestMessage = conversation.messages.at(-1) ?? null;

  return {
    thread: conversation.thread
      ? {
          ...conversation.thread,
          projectId: session.project.id
        }
      : null,
    messages: conversation.messages,
    openQuestion: router.openQuestion ? toHumanQuestionRecord(router.openQuestion) : null,
    latestSummary: latestMessage?.summary ?? null,
    openQuestionRun: null
  };
}

async function addDirectorNote(session: ProjectSession, content: string): Promise<DirectorNoteRecord> {
  const router = await loadRouterState(session.paths, session.project.slug);
  const timestamp = nowIso();
  const note: DirectorNoteRecord = {
    id: nextNumericId(router.notes),
    projectId: session.project.id,
    content,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await saveRouterState(session.paths, {
    ...router,
    notes: [...router.notes, note]
  });

  return note;
}

function recordRun(
  session: ProjectSession,
  router: RouterState,
  input: Omit<RunRecord, "id" | "projectId" | "createdAt" | "updatedAt">
): RouterState {
  const timestamp = nowIso();
  const run: RunRecord = {
    id: nextNumericId(router.recentRuns),
    projectId: session.project.id,
    workItemId: input.workItemId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    role: input.role,
    status: input.status,
    phase: input.phase,
    summary: input.summary,
    recommendedNextAction: input.recommendedNextAction,
    artifacts: input.artifacts,
    blockingQuestions: input.blockingQuestions,
    outputJson: input.outputJson,
    rawModelOutput: input.rawModelOutput,
    worktreePath: input.worktreePath,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  return {
    ...router,
    recentRuns: [...router.recentRuns, run].slice(-20)
  };
}

function applyChiefOfStaffTurn(
  session: ProjectSession,
  router: RouterState,
  input: {
    sessionId: string | null;
    phase: string;
    result: {
      status: "ok" | "needs_input" | "failed";
      summary: string;
      recommended_next_action: string;
      artifact_refs: string[];
      blocking_questions: string[];
      data?: Record<string, unknown> | null;
      raw_model_output?: string | null;
    };
    issueNumber?: number | null;
    prNumber?: number | null;
  }
): RouterState {
  return recordRun(session, {
    ...router,
    chiefOfStaff: {
      sessionId: input.sessionId ?? router.chiefOfStaff.sessionId,
      lastSummary: input.result.summary,
      updatedAt: nowIso()
    }
  }, {
    workItemId: null,
    issueNumber: input.issueNumber ?? null,
    prNumber: input.prNumber ?? null,
    role: "chief_of_staff",
    status: mapAgentStatusToRunStatus(input.result.status),
    phase: input.phase,
    summary: input.result.summary,
    recommendedNextAction: input.result.recommended_next_action,
    artifacts: input.result.artifact_refs,
    blockingQuestions: input.result.blocking_questions,
    outputJson: input.result.data ?? null,
    rawModelOutput: input.result.raw_model_output ?? null,
    worktreePath: null
  });
}

function applyLaneTurn(
  session: ProjectSession,
  router: RouterState,
  lane: RouterLaneState,
  input: {
    sessionId: string | null;
    phase: string;
    result: {
      status: "ok" | "needs_input" | "failed";
      summary: string;
      recommended_next_action: string;
      artifact_refs: string[];
      blocking_questions: string[];
      data?: Record<string, unknown> | null;
      raw_model_output?: string | null;
    };
    issueNumber: number;
  }
): RouterState {
  lane.sessionId = input.sessionId ?? lane.sessionId;
  lane.lastSummary = input.result.summary;
  if (input.phase === "planning") {
    lane.lastPlanSummary = input.result.summary;
  }
  lane.updatedAt = nowIso();

  return recordRun(session, router, {
    workItemId: null,
    issueNumber: input.issueNumber,
    prNumber: null,
    role: "lane_owner",
    status: mapAgentStatusToRunStatus(input.result.status),
    phase: input.phase,
    summary: input.result.summary,
    recommendedNextAction: input.result.recommended_next_action,
    artifacts: input.result.artifact_refs,
    blockingQuestions: input.result.blocking_questions,
    outputJson: input.result.data ?? null,
    rawModelOutput: input.result.raw_model_output ?? null,
    worktreePath: null
  });
}

function buildLanePrompt(
  session: ProjectSession,
  lane: RouterLaneState,
  issue: GitHubIssueRecord,
  handoff: RouterHandoffState
): string {
  const handoffSummary = handoff.summary?.trim() || "Chief of Staff routed this issue to your lane.";
  const priorGuidance = parseDataString(handoff.details?.guidance) ?? null;
  const humanGuidance = parseDataString(handoff.details?.human_guidance) ?? null;

  return [
    "You are a persistent lane Codex session owned by the Chief of Staff in Director OS.",
    "Stay within your lane context. Do not address the human directly. The Chief of Staff handles all human-facing communication.",
    handoff.kind === "plan"
      ? "Task: take ownership of this issue and produce a concise lane plan using Codex's native planning mindset."
      : "Task: take ownership of this issue and produce a concise implementation handoff for the Chief of Staff.",
    "Return structured output only.",
    "If you are blocked on product or taste judgment, set `status` to `needs_input` and put the exact blocker in `blocking_questions`.",
    "Use `data.transcript_reply` for the short update the Chief of Staff should relay back up.",
    "",
    `Lane: ${lane.name} (${lane.id})`,
    `Issue: #${issue.number} ${issue.title}`,
    "",
    "Chief of Staff handoff:",
    handoffSummary,
    "",
    "Issue body:",
    issue.body.trim() || "No issue body provided.",
    "",
    "Recent CoS conversation:",
    "Use the existing session context plus this explicit handoff. Focus on next-step routing, not generic analysis."
  ]
    .concat(
      priorGuidance ? ["", "Chief of Staff guidance:", priorGuidance] : [],
      humanGuidance ? ["", "Human guidance:", humanGuidance] : [],
      lane.lastPlanSummary ? ["", "Existing lane plan summary:", lane.lastPlanSummary] : [],
      lane.lastSummary ? ["", "Latest lane summary:", lane.lastSummary] : []
    )
    .join("\n");
}

function blockedQuestionForLane(
  issue: GitHubIssueRecord,
  summary: string,
  blockingQuestion: string,
  recommendation: string | null
): Omit<RouterQuestionState, "id" | "createdAt" | "updatedAt"> {
  return {
    title: `Chief of Staff question for #${issue.number}`,
    summary,
    question: blockingQuestion,
    whyItMatters: summary,
    recommendation:
      recommendation ?? "Reply here with the decision you want me to take so I can resume the lane.",
    issueNumber: issue.number,
    prNumber: null,
    runId: null,
    requestedBy: "lane"
  };
}

async function syncProjectInternal(session: ProjectSession): Promise<DirectorOperationResponse> {
  const [issues, pullRequests, comments] = await Promise.all([
    listIssues(session.project.repoSlug),
    listPullRequests(session.project.repoSlug),
    listComments(session.project.repoSlug)
  ]);

  const syncedAt = nowIso();
  const cache: GitHubCacheState = {
    version: 1,
    syncedAt,
    issues,
    pullRequests,
    comments
  };
  await saveGitHubCacheState(session.paths, cache, session.project.slug);

  const router = await loadRouterState(session.paths, session.project.slug);
  const nextRouter = {
    ...router,
    lastSyncAt: syncedAt,
    orchestrator: {
      ...router.orchestrator,
      lastSummary: `Synced ${issues.length} issues and ${pullRequests.length} pull requests.`,
      lastLoopAt: syncedAt
    }
  };
  await saveRouterState(session.paths, nextRouter);

  return {
    ok: true,
    message: `Synced ${issues.length} issues and ${pullRequests.length} pull requests.`,
    syncedAt,
    issueCount: issues.length,
    pullRequestCount: pullRequests.length
  };
}

async function runCoSChatReply(session: ProjectSession, content: string): Promise<CoSChatReply> {
  const prompt = buildChiefOfStaffPrompt(COS_TASK_APPENDICES.replyInChat, [
    {
      title: "Recent conversation",
      content: await recentConversationPrompt(session)
    },
    {
      title: "Latest director message",
      content
    }
  ]);

  const router = await loadRouterState(session.paths, session.project.slug);
  const turn = await runCodexSessionAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt,
      sessionId: router.chiefOfStaff.sessionId
    },
    {
      status: "ok",
      summary: "Noted. I’ll use that direction to steer prioritization and execution.",
      recommended_next_action: "Continue routing work through the Chief of Staff.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        kind: "cos_reply",
        reply: "Noted. I’ll use that direction to steer prioritization and execution."
      }
    }
  );

  const nextRouter = applyChiefOfStaffTurn(session, router, {
    sessionId: turn.sessionId,
    phase: "chat",
    result: turn.result
  });
  await saveRouterState(session.paths, nextRouter);
  const run = assertPresent(nextRouter.recentRuns.at(-1), "Recent run was not recorded.");

  const data = turn.result.data ?? undefined;
  return {
    kind: parseDataString(data?.kind) === "cos_question" ? "cos_question" : "cos_reply",
    reply: parseDataString(data?.reply) ?? turn.result.summary,
    question: parseDataString(data?.question) ?? null,
    recommendation: parseDataString(data?.recommendation) ?? null,
    rationale: parseDataString(data?.rationale) ?? null,
    run
  };
}

async function resolveOpenQuestion(
  session: ProjectSession,
  router: RouterState,
  resolution: string
): Promise<HumanQuestionRecord> {
  const question = assertPresent(router.openQuestion, "No open question exists.");
  const nextRouter: RouterState = {
    ...router,
    openQuestion: null,
    orchestrator: {
      ...router.orchestrator,
      lastSummary: "Human guidance received."
    }
  };

  if (question.issueNumber !== null) {
    const blockedHandoff =
      [...nextRouter.pendingHandoffs]
        .reverse()
        .find(
          (handoff) => handoff.issueNumber === question.issueNumber && handoff.status === "blocked"
        ) ?? null;

    if (blockedHandoff) {
      blockedHandoff.status = "pending";
      blockedHandoff.summary = `Human guidance: ${summarizeText(resolution)}`;
      blockedHandoff.details = {
        ...(blockedHandoff.details ?? {}),
        human_guidance: resolution
      };
      blockedHandoff.updatedAt = nowIso();

      const lane = findLaneById(nextRouter, blockedHandoff.laneId);
      if (lane) {
        lane.status =
          blockedHandoff.kind === "plan"
            ? "planning"
            : blockedHandoff.kind === "review"
              ? "waiting_review"
              : "implementing";
        lane.lastSummary = `Human guidance received for #${question.issueNumber}.`;
        lane.updatedAt = nowIso();
      }
    }
  }

  await saveRouterState(session.paths, recordRun(session, nextRouter, {
      workItemId: null,
      issueNumber: question.issueNumber,
      prNumber: question.prNumber,
      role: "chief_of_staff",
      status: "succeeded",
      phase: "question_resolution",
      summary: "Human guidance received.",
      recommendedNextAction: "Resume the router loop.",
      artifacts: [],
      blockingQuestions: [],
      outputJson: {
        resolution
      },
      rawModelOutput: null,
      worktreePath: null
    }));

  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "resolution",
    content: formatResolutionMessage(question, resolution),
    summary: summarizeText(resolution),
    linkedIssueNumber: question.issueNumber,
    linkedPrNumber: question.prNumber,
    linkedPullRequestNumber: question.prNumber,
    isOpenQuestion: false
  });

  return toHumanQuestionRecord(question);
}

async function chooseNextIssue(session: ProjectSession): Promise<void> {
  const [router, cache] = await Promise.all([
    loadRouterState(session.paths, session.project.slug),
    loadGitHubCacheState(session.paths, session.project.slug)
  ]);

  if (router.openQuestion) {
    await saveRouterState(session.paths, {
      ...router,
      orchestrator: {
        ...router.orchestrator,
        lastLoopAt: nowIso(),
        lastSummary: "Waiting for the open Chief of Staff question to be resolved."
      }
    });
    return;
  }

  const issues = cache.issues
    .map((issue) => mapRemoteIssue(session.project, issue))
    .filter((issue) => issue.state.toLowerCase() === "open")
    .filter((issue) => issue.workflowState === "ready" || issue.workflowState === "queued")
    .filter((issue) => !hasPendingLaneWork(router, issue.number));

  if (!issues.length) {
    await saveRouterState(session.paths, {
      ...router,
      orchestrator: {
        ...router.orchestrator,
        lastLoopAt: nowIso(),
        lastSummary: "No unassigned ready GitHub issues are available right now."
      }
    });
    return;
  }

  const fallbackIssue = assertPresent(issues[0], "No queueable issue is available.");
  const fallbackLane = defaultLaneForIssue(fallbackIssue);
  const fallbackIntent = defaultExecutionIntentForIssue(fallbackIssue);

  const prompt = buildChiefOfStaffPrompt(COS_TASK_APPENDICES.chooseNextIssue, [
    {
      title: "Existing lanes",
      content:
        router.lanes.length > 0
          ? router.lanes
              .map((lane) => `- ${lane.name} (${lane.id}): ${lane.issueNumbers.join(", ") || "no issues"}`)
              .join("\n")
          : "No lane sessions exist yet."
    },
    {
      title: "Open issues",
      content: truncatePromptSection(
        issues.map((issue) => `#${issue.number} [${issue.workflowState}] ${issue.title}`).join("\n")
      )
    }
  ]);

  const turn = await runCodexSessionAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt,
      sessionId: router.chiefOfStaff.sessionId
    },
    {
      status: "ok",
      summary: `Selected issue #${fallbackIssue.number} as the next ready slice.`,
      recommended_next_action: "Route the issue into a lane or bounded implementation session.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        selected_issue_number: fallbackIssue.number,
        execution_intent: fallbackIntent,
        lane_id: fallbackLane.id,
        lane_name: fallbackLane.name
      }
    }
  );

  const selectedIssueNumber = parseDataNumber(turn.result.data?.selected_issue_number) ?? fallbackIssue.number;
  const selectedIssue =
    issues.find((issue) => issue.number === selectedIssueNumber) ?? fallbackIssue;
  const laneFallback = defaultLaneForIssue(selectedIssue);
  const laneId = slugify(parseDataString(turn.result.data?.lane_id) ?? laneFallback.id);
  const laneName = parseDataString(turn.result.data?.lane_name) ?? laneFallback.name;
  const executionIntent =
    parseDataString(turn.result.data?.execution_intent) === "plan"
      ? "plan"
      : defaultExecutionIntentForIssue(selectedIssue);

  const nextRouter = applyChiefOfStaffTurn(session, router, {
    sessionId: turn.sessionId,
    phase: "queue_review",
    result: turn.result,
    issueNumber: selectedIssue.number
  });
  const lane = ensureLane(nextRouter, laneId, laneName);
  if (!lane.issueNumbers.includes(selectedIssue.number)) {
    lane.issueNumbers.push(selectedIssue.number);
  }
  lane.currentIssueNumber = selectedIssue.number;
  lane.status = executionIntent === "plan" ? "planning" : "implementing";
  lane.updatedAt = nowIso();
  nextRouter.issueOwnership[String(selectedIssue.number)] = lane.id;
  enqueueHandoff(nextRouter, {
    laneId: lane.id,
    issueNumber: selectedIssue.number,
    kind: executionIntent,
    status: "pending",
    summary:
      parseDataString(turn.result.data?.transcript_reply) ??
      `Chief of Staff routed issue #${selectedIssue.number} to lane ${lane.name}.`,
    prNumber: null,
    branchName: null,
    worktreePath: null,
    reviewWindowEndsAt: null,
    lastHandledCommentAt: null,
    details:
      parseDataString(turn.result.data?.guidance) !== null
        ? {
            guidance: parseDataString(turn.result.data?.guidance)
          }
        : null
  });
  nextRouter.orchestrator = {
    ...nextRouter.orchestrator,
    lastLoopAt: nowIso(),
    lastSummary: `Routed issue #${selectedIssue.number} to lane ${lane.name} for ${executionIntent}.`
  };

  await saveRouterState(session.paths, nextRouter);
  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "status_update",
    content: `I routed issue #${selectedIssue.number} to lane ${lane.name} for ${executionIntent}.`,
    summary: `Routed #${selectedIssue.number} to ${lane.name}`,
    linkedIssueNumber: selectedIssue.number,
    linkedPrNumber: null,
    linkedPullRequestNumber: null,
    isOpenQuestion: false
  });
}

async function mediateLaneBlocker(
  session: ProjectSession,
  router: RouterState,
  lane: RouterLaneState,
  issue: GitHubIssueRecord,
  handoff: RouterHandoffState,
  laneResult: {
    status: "ok" | "needs_input" | "failed";
    summary: string;
    recommended_next_action: string;
    artifact_refs: string[];
    blocking_questions: string[];
    data?: Record<string, unknown> | null;
    raw_model_output?: string | null;
  }
): Promise<RouterState> {
  const fallbackQuestion =
    laneResult.blocking_questions[0] ??
    `Lane ${lane.name} is blocked on issue #${issue.number} and needs direction before continuing.`;
  const prompt = buildChiefOfStaffPrompt(COS_TASK_APPENDICES.mediateBlocker, [
    {
      title: "Lane",
      content: `${lane.name} (${lane.id})`
    },
    {
      title: "Issue",
      content: `#${issue.number}: ${issue.title}\n\n${issue.body.trim() || "No issue body provided."}`
    },
    {
      title: "Lane summary",
      content: laneResult.summary
    },
    {
      title: "Blocking questions",
      content: laneResult.blocking_questions.join("\n") || fallbackQuestion
    },
    {
      title: "Lane relay",
      content: parseDataString(laneResult.data?.transcript_reply)
    }
  ]);

  const turn = await runCodexSessionAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt,
      sessionId: router.chiefOfStaff.sessionId
    },
    {
      status: "needs_input",
      summary: `Lane ${lane.name} is blocked on issue #${issue.number}.`,
      recommended_next_action: "Ask the director for the missing decision through the Chief of Staff chat.",
      artifact_refs: [],
      blocking_questions: [fallbackQuestion],
      data: {
        outcome: "ask_human",
        question: fallbackQuestion,
        recommendation: "Reply in the CoS chat with the decision you want me to take."
      }
    }
  );

  const nextRouter = applyChiefOfStaffTurn(session, router, {
    sessionId: turn.sessionId,
    phase: "blocker_mediation",
    result: turn.result,
    issueNumber: issue.number
  });
  const outcome = parseDataString(turn.result.data?.outcome);
  const guidance = parseDataString(turn.result.data?.guidance);
  const transcriptReply =
    parseDataString(turn.result.data?.transcript_reply) ?? turn.result.summary;

  if (outcome === "answer_worker" || outcome === "reroute") {
    handoff.status = "completed";
    handoff.updatedAt = nowIso();
    lane.status = handoff.kind === "plan" ? "planning" : "implementing";
    lane.lastSummary = transcriptReply;
    lane.updatedAt = nowIso();
    enqueueHandoff(nextRouter, {
      laneId: lane.id,
      issueNumber: issue.number,
      kind: handoff.kind,
      status: "pending",
      summary: guidance ?? transcriptReply,
      prNumber: handoff.prNumber,
      branchName: handoff.branchName,
      worktreePath: handoff.worktreePath,
      reviewWindowEndsAt: handoff.reviewWindowEndsAt,
      lastHandledCommentAt: handoff.lastHandledCommentAt,
      details: {
        guidance: guidance ?? transcriptReply
      }
    });
    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary: `Chief of Staff resolved a blocker for lane ${lane.name} on issue #${issue.number}.`
    };
    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content: `I resolved a blocker for lane ${lane.name} on issue #${issue.number} and resumed the lane.`,
      summary: `Resumed ${lane.name} on #${issue.number}`,
      linkedIssueNumber: issue.number,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });
    return nextRouter;
  }

  handoff.status = "blocked";
  handoff.updatedAt = nowIso();
  lane.status = "blocked";
  lane.updatedAt = nowIso();

  const questionSeed = blockedQuestionForLane(
    issue,
    turn.result.summary,
    parseDataString(turn.result.data?.question) ?? fallbackQuestion,
    parseDataString(turn.result.data?.recommendation)
  );
  const timestamp = nowIso();
  nextRouter.openQuestion = {
    id: `question_${Date.now()}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...questionSeed,
    runId: assertPresent(
      nextRouter.recentRuns.at(-1),
      "Chief of Staff mediation run should have been recorded."
    ).id
  };
  nextRouter.orchestrator = {
    ...nextRouter.orchestrator,
    lastLoopAt: nowIso(),
    lastSummary: `Chief of Staff needs human guidance for issue #${issue.number}.`
  };

  await saveRouterState(session.paths, nextRouter);
  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "cos_question",
    content: formatHumanQuestionContent(
      nextRouter.openQuestion.question,
      nextRouter.openQuestion.whyItMatters,
      nextRouter.openQuestion.recommendation
    ),
    summary: summarizeText(nextRouter.openQuestion.question),
    linkedIssueNumber: issue.number,
    linkedPrNumber: null,
    linkedPullRequestNumber: null,
    isOpenQuestion: true
  });

  return nextRouter;
}

async function dispatchPendingHandoff(session: ProjectSession): Promise<boolean> {
  const [router, cache] = await Promise.all([
    loadRouterState(session.paths, session.project.slug),
    loadGitHubCacheState(session.paths, session.project.slug)
  ]);

  if (router.openQuestion) {
    return false;
  }

  const handoff = pendingHandoff(router);
  if (!handoff) {
    return false;
  }

  const lane = ensureLane(router, handoff.laneId, handoff.laneId);
  const issue =
    cache.issues
      .map((candidate) => mapRemoteIssue(session.project, candidate))
      .find((candidate) => candidate.number === handoff.issueNumber) ?? null;

  if (!issue) {
    handoff.status = "blocked";
    handoff.summary = `Issue #${handoff.issueNumber} is missing from the GitHub cache.`;
    handoff.updatedAt = nowIso();
    lane.status = "blocked";
    lane.updatedAt = nowIso();
    await saveRouterState(session.paths, {
      ...router,
      orchestrator: {
        ...router.orchestrator,
        lastLoopAt: nowIso(),
        lastSummary: `Issue #${handoff.issueNumber} is missing from the local GitHub mirror.`
      }
    });
    return true;
  }

  const turn = await runCodexSessionAgent(
    {
      role: "lane_owner",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt: buildLanePrompt(session, lane, issue, handoff),
      sessionId: lane.sessionId
    },
    {
      status: "ok",
      summary: `Lane ${lane.name} acknowledged issue #${issue.number}.`,
      recommended_next_action: "Keep routing follow-up work through the lane session.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        transcript_reply: `Lane ${lane.name} is attached to issue #${issue.number}.`
      }
    }
  );

  const nextRouter = applyLaneTurn(session, router, lane, {
    sessionId: turn.sessionId,
    phase: handoff.kind === "plan" ? "planning" : handoff.kind,
    result: turn.result,
    issueNumber: issue.number
  });
  const relay = parseDataString(turn.result.data?.transcript_reply) ?? turn.result.summary;

  if (turn.result.status === "needs_input" || turn.result.blocking_questions.length > 0) {
    handoff.summary = relay;
    handoff.updatedAt = nowIso();
    await mediateLaneBlocker(session, nextRouter, lane, issue, handoff, turn.result);
    return true;
  }

  handoff.status = "completed";
  handoff.summary = relay;
  handoff.updatedAt = nowIso();
  lane.status = handoff.kind === "plan" ? "planning" : "implementing";
  lane.currentIssueNumber = issue.number;
  lane.updatedAt = nowIso();
  nextRouter.orchestrator = {
    ...nextRouter.orchestrator,
    lastLoopAt: nowIso(),
    lastSummary: `Lane ${lane.name} updated issue #${issue.number}.`
  };

  await saveRouterState(session.paths, nextRouter);
  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "status_update",
    content: `Lane ${lane.name} took ownership of issue #${issue.number}. ${relay}`,
    summary: `Lane ${lane.name} updated #${issue.number}`,
    linkedIssueNumber: issue.number,
    linkedPrNumber: null,
    linkedPullRequestNumber: null,
    isOpenQuestion: false
  });
  return true;
}

async function runOrchestratorLoop(): Promise<void> {
  if (orchestratorRunning) {
    return;
  }

  orchestratorRunning = true;
  let shouldReschedule = false;

  try {
    await withProject(async (session) => {
      const lock = await readOrchestratorLock(session.paths);
      if (lock?.token !== ORCHESTRATOR_OWNER_TOKEN) {
        return;
      }

      const router = await loadRouterState(session.paths, session.project.slug);
      if (router.orchestrator.status !== "running") {
        return;
      }

      shouldReschedule = true;
      await syncProjectInternal(session);
      if (!(await dispatchPendingHandoff(session))) {
        await chooseNextIssue(session);
        await dispatchPendingHandoff(session);
      }
    });
  } finally {
    orchestratorRunning = false;
    if (shouldReschedule) {
      scheduleOrchestratorLoop();
    }
  }
}

function scheduleOrchestratorLoop(delayMs = LOOP_INTERVAL_MS): void {
  if (orchestratorTimer) {
    clearTimeout(orchestratorTimer);
  }

  orchestratorTimer = setTimeout(() => {
    orchestratorTimer = null;
    void runOrchestratorLoop().catch((error) => {
      console.error(error);
    });
  }, delayMs);
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);

    if (activeProject) {
      const { draft, repositoryCheck } = await buildRepositoryDraft(
        {
          repoPath: activeProject.repoPath,
          projectName: activeProject.name,
          worktreeRoot: activeProject.worktreeRoot,
          model: activeProject.model
        },
        session.paths
      );

      return evaluateSetupState(session, {
        activeProject,
        repositoryDraft: draft ?? projectToSetupDraft(activeProject),
        repositoryCheck,
        runWorkspace: true
      });
    }

    return evaluateSetupState(session, {
      activeProject: null,
      repositoryDraft: null,
      runWorkspace: false
    });
  });
}

export async function probeRepositorySetup(
  input: SetupProbeRepositoryInput
): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);
    const { draft, repositoryCheck } = await buildRepositoryDraft(input, session.paths);

    return evaluateSetupState(session, {
      activeProject,
      repositoryDraft: draft,
      repositoryCheck,
      runWorkspace: false
    });
  });
}

export async function runWorkspaceSetupTest(
  repositoryDraft: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);
    const { draft, repositoryCheck } = await buildRepositoryDraft(
      {
        repoPath: repositoryDraft.repoPath,
        projectName: repositoryDraft.projectName,
        worktreeRoot: repositoryDraft.worktreeRoot,
        model: repositoryDraft.model
      },
      session.paths
    );

    return evaluateSetupState(session, {
      activeProject,
      repositoryDraft: draft ?? repositoryDraft,
      repositoryCheck,
      runWorkspace: true
    });
  });
}

export async function completeSetup(
  repositoryDraft: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);
    const { draft, repositoryCheck } = await buildRepositoryDraft(
      {
        repoPath: repositoryDraft.repoPath,
        projectName: repositoryDraft.projectName,
        worktreeRoot: repositoryDraft.worktreeRoot,
        model: repositoryDraft.model
      },
      session.paths
    );
    const resolvedDraft = draft ?? repositoryDraft;

    const status = await evaluateSetupState(session, {
      activeProject,
      repositoryDraft: resolvedDraft,
      repositoryCheck,
      runWorkspace: true
    });

    if (!status.canComplete) {
      const blocking = status.checks
        .filter((candidate) => candidate.status !== "ready")
        .map((candidate) => `${candidate.title}: ${candidate.detail}`)
        .join(" ");
      throw new Error(blocking || "Setup is not ready to complete yet.");
    }

    const storedProject = await persistProjectRegistration(session, resolvedDraft);
    return evaluateSetupState(session, {
      activeProject: storedProject,
      repositoryDraft: projectToSetupDraft(storedProject),
      runWorkspace: true
    });
  });
}

export async function initDirector(options: InitCommandOptions = {}) {
  const paths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const repoPath = resolveRepoPath(options.repoPath ?? process.cwd());

  if (options.noProjectRegistration) {
    return {
      ok: true,
      paths,
      project: null
    };
  }

  return withRuntime(async (session) => {
    if (!options.skipGhCheck) {
      await ensureGhAuthenticated();
    }

    const { draft: discoveredDraft } = await buildRepositoryDraft(
      {
        repoPath,
        projectName: options.projectName,
        worktreeRoot: options.worktreeRoot,
        model: options.model
      },
      session.paths
    );

    let detected: Awaited<ReturnType<typeof detectRepoFromPath>> | null = null;
    if (!discoveredDraft?.repoSlug || !discoveredDraft.defaultBranch || !options.projectName) {
      try {
        detected = await detectRepoFromPath(repoPath);
      } catch {
        if (options.repoSlug) {
          detected = await fetchRepoDetails(options.repoSlug);
        }
      }
    }

    const finalDraft: SetupRepositoryDraft = {
      repoPath,
      projectName:
        options.projectName?.trim() ||
        discoveredDraft?.projectName ||
        detected?.name ||
        path.basename(repoPath),
      repoSlug:
        options.repoSlug?.trim() || discoveredDraft?.repoSlug || detected?.repoSlug || "",
      defaultBranch:
        options.defaultBranch?.trim() ||
        discoveredDraft?.defaultBranch ||
        detected?.defaultBranch ||
        "main",
      worktreeRoot:
        options.worktreeRoot?.trim() ||
        discoveredDraft?.worktreeRoot ||
        path.join(paths.worktreesDir, slugify(options.projectName || discoveredDraft?.projectName || path.basename(repoPath))),
      agentRunner: options.agentRunner?.trim() || discoveredDraft?.agentRunner || "codex",
      model: options.model?.trim() || discoveredDraft?.model || "gpt-5.4"
    };

    const status = await evaluateSetupState(session, {
      activeProject: null,
      repositoryDraft: finalDraft,
      runWorkspace: true
    });

    if (!status.canComplete) {
      const blocking = status.checks
        .filter((candidate) => candidate.status !== "ready")
        .map((candidate) => `${candidate.title}: ${candidate.detail}`)
        .join(" ");
      throw new Error(blocking || "Director OS could not be initialized.");
    }

    const project = await persistProjectRegistration(session, finalDraft);
    return {
      ok: true,
      paths,
      project
    };
  });
}

export async function syncProject(): Promise<DirectorOperationResponse> {
  return withProject(async (session) => syncProjectInternal(session));
}

export async function getDirectorStatus(): Promise<DirectorStatusResponse> {
  return withProject(async (session) => {
    const [router, cache, owner] = await Promise.all([
      loadRouterState(session.paths, session.project.slug),
      loadGitHubCacheState(session.paths, session.project.slug),
      readOrchestratorLock(session.paths)
    ]);

    const issues = cache.issues.map((issue) => mapRemoteIssue(session.project, issue));
    const pullRequests = cache.pullRequests.map((pullRequest) =>
      mapRemotePullRequest(session.project, pullRequest, cache.syncedAt)
    );
    const openPullRequests = pullRequests
      .filter((pullRequest) => pullRequest.state.toLowerCase() === "open")
      .sort((left, right) => left.number - right.number);

    return {
      project: session.project,
      orchestrator: synthesizeOrchestratorStatus(session.project, router, owner),
      lastSuccessfulSyncAt: router.lastSyncAt,
      lanes: router.lanes.map((lane) => synthesizeLaneRecord(lane, openPullRequests)),
      issues: issues.map((issue) => synthesizeIssueOwnership(issue, router, pullRequests)),
      openQuestion: router.openQuestion ? toHumanQuestionRecord(router.openQuestion) : null,
      recentActivity: synthesizeActivity(router),
      openPullRequests
    };
  });
}

export async function listDecisions(): Promise<DecisionsResponse> {
  return withProject(async (session) => {
    const router = await loadRouterState(session.paths, session.project.slug);
    return {
      decisions: router.openQuestion ? [toHumanQuestionRecord(router.openQuestion)] : []
    };
  });
}

export async function getConversation(): Promise<ConversationResponse> {
  return withProject(async (session) => getConversationResponse(session));
}

export async function sendConversationMessage(content: string): Promise<ConversationResponse> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Message cannot be empty.");
  }

  return withProject(async (session) => {
    await appendConversationMessage(session, {
      role: "director",
      kind: "human_message",
      content: trimmed,
      summary: summarizeText(trimmed),
      linkedIssueNumber: null,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });

    const router = await loadRouterState(session.paths, session.project.slug);
    if (router.openQuestion) {
      await resolveOpenQuestion(session, router, trimmed);
    } else {
      const reply = await runCoSChatReply(session, trimmed);

      if (reply.kind === "cos_question") {
        const timestamp = nowIso();
        await saveRouterState(session.paths, {
          ...router,
          openQuestion: {
            id: `question_${Date.now()}`,
            title: "Chief of Staff question",
            summary: reply.reply,
            question: reply.question ?? "I need a little more direction before I continue.",
            whyItMatters: reply.reply,
            recommendation:
              reply.recommendation ?? "Reply here with the direction you want me to take.",
            issueNumber: null,
            prNumber: null,
            runId: reply.run.id,
            requestedBy: "chief_of_staff",
            createdAt: timestamp,
            updatedAt: timestamp
          },
          orchestrator: {
            ...router.orchestrator,
            lastSummary: "Chief of Staff is waiting on human direction."
          }
        });

        await appendConversationMessage(session, {
          role: "chief_of_staff",
          kind: "cos_question",
          content: formatHumanQuestionContent(
            reply.question ?? "I need a little more direction before I continue.",
            reply.reply,
            reply.recommendation ?? "Reply here with the direction you want me to take."
          ),
          summary: summarizeText(reply.question ?? reply.reply),
          linkedIssueNumber: null,
          linkedPrNumber: null,
          linkedPullRequestNumber: null,
          isOpenQuestion: true
        });
      } else {
        await appendConversationMessage(session, {
          role: "chief_of_staff",
          kind: "cos_reply",
          content: reply.reply,
          summary: summarizeText(reply.reply),
          linkedIssueNumber: null,
          linkedPrNumber: null,
          linkedPullRequestNumber: null,
          isOpenQuestion: false
        });
      }
    }

    const refreshedRouter = await loadRouterState(session.paths, session.project.slug);
    if (refreshedRouter.orchestrator.status === "running" && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }

    return getConversationResponse(session);
  });
}

export async function submitDirectorNote(content: string): Promise<DirectorNoteRecord> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Director note cannot be empty.");
  }

  return withProject(async (session) => {
    const note = await addDirectorNote(session, trimmed);
    await appendConversationMessage(session, {
      role: "director",
      kind: "human_message",
      content: trimmed,
      summary: summarizeText(trimmed),
      linkedIssueNumber: null,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });

    const router = await loadRouterState(session.paths, session.project.slug);
    if (router.orchestrator.status === "running" && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }

    return note;
  });
}

export async function resolveDecision(
  decisionId: string,
  resolution: string
): Promise<HumanQuestionRecord> {
  const trimmed = resolution.trim();
  if (!trimmed) {
    throw new Error("Resolution cannot be empty.");
  }

  return withProject(async (session) => {
    const router = await loadRouterState(session.paths, session.project.slug);
    if (!router.openQuestion || router.openQuestion.id !== decisionId) {
      throw new Error(`Decision ${decisionId} was not found.`);
    }

    const resolved = await resolveOpenQuestion(session, router, trimmed);
    const refreshedRouter = await loadRouterState(session.paths, session.project.slug);
    if (refreshedRouter.orchestrator.status === "running" && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }

    return resolved;
  });
}

export async function startOrchestrator(): Promise<DirectorOperationResponse> {
  const paths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const ownership = await acquireOrchestratorLock(paths);

  if (ownership === "busy") {
    return {
      ok: true,
      message: "Chief of Staff is already running in another local Director OS process."
    };
  }

  const response = await withProject(async (session) => {
    const router = await loadRouterState(session.paths, session.project.slug);
    await saveRouterState(session.paths, {
      ...router,
      orchestrator: {
        ...router.orchestrator,
        status: "running",
        pauseReason: null,
        lastLoopAt: nowIso(),
        lastSummary: "Chief of Staff router is running."
      }
    });

    return {
      ok: true,
      message: "Chief of Staff loop started."
    };
  });

  scheduleOrchestratorLoop(0);
  return response;
}

export async function pauseOrchestrator(reason?: string): Promise<DirectorOperationResponse> {
  const response = await withProject(async (session) => {
    const router = await loadRouterState(session.paths, session.project.slug);
    await saveRouterState(session.paths, {
      ...router,
      orchestrator: {
        ...router.orchestrator,
        status: "paused",
        pauseReason: reason?.trim() || "Paused by the director.",
        lastSummary: "Chief of Staff loop paused."
      }
    });

    return {
      ok: true,
      message: "Chief of Staff loop paused."
    };
  });

  if (orchestratorTimer) {
    clearTimeout(orchestratorTimer);
    orchestratorTimer = null;
  }
  await releaseOrchestratorLock(await ensureRuntimeDirectories(resolveRuntimePaths()));
  return response;
}
