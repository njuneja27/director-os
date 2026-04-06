import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ActivityRecord,
  ConversationMessageRecord,
  ConversationResponse,
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

import {
  probeCodexCli,
  runCodexSessionAgent,
  runCodexSessionTurn
} from "./agents.js";
import { runCommandOrThrow } from "./commands.js";
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
  commentOnIssue,
  createIssue,
  createPullRequest,
  detectRepoFromPath,
  ensureGhAuthenticated,
  fetchRepoDetails,
  listComments,
  listIssues,
  listPullRequests,
  probeGhCli,
  probeRepositoryPath,
  resolveRepoPath,
  viewPullRequest
} from "./github.js";
import { parseGitWorktreeList, selectReusableGitWorktree } from "./git-worktrees.js";
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
const CHIEF_OF_STAFF_OWNER_ID = "chief_of_staff";

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

interface ProposedIssueTask {
  title: string;
  body: string;
  kind: string;
  execution_mode: string;
}

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

function extractIssueNumbers(value: string): number[] {
  const matches = value.matchAll(/#(\d+)/g);
  const seen = new Set<number>();
  const issueNumbers: number[] = [];

  for (const match of matches) {
    const issueNumber = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(issueNumber) || seen.has(issueNumber)) {
      continue;
    }

    seen.add(issueNumber);
    issueNumbers.push(issueNumber);
  }

  return issueNumbers;
}

function selectDirectedIssue(
  issues: GitHubIssueRecord[],
  messages: ConversationMessageRecord[]
): GitHubIssueRecord | null {
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));

  for (const message of [...messages].reverse()) {
    if (message.role !== "director") {
      continue;
    }

    for (const issueNumber of extractIssueNumbers(message.content)) {
      const issue = issuesByNumber.get(issueNumber);
      if (issue) {
        return issue;
      }
    }
  }

  return null;
}

function priorityGuidancePrompt(
  issue: GitHubIssueRecord | null,
  messages: ConversationMessageRecord[]
): string {
  if (!issue) {
    return "No explicit issue priority is active from the director right now.";
  }

  const latestInstruction =
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "director" && extractIssueNumbers(message.content).includes(issue.number)
      ) ?? null;

  return [
    `The director explicitly asked for issue #${issue.number} (${issue.title}) next.`,
    "Prefer that issue while it remains open and ready unless a harder blocker makes it impossible.",
    latestInstruction ? `Latest instruction: ${summarizeText(latestInstruction.content, 400)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function parseDataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseIssueTasks(value: unknown): ProposedIssueTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const title = parseDataString((entry as Record<string, unknown>).title);
    const body = parseDataString((entry as Record<string, unknown>).body);
    const kind = parseDataString((entry as Record<string, unknown>).kind);
    const executionMode = parseDataString((entry as Record<string, unknown>).execution_mode);

    if (!title || !body || !kind || !executionMode) {
      return [];
    }

    return [
      {
        title,
        body,
        kind,
        execution_mode: executionMode
      }
    ];
  });
}

function labelsForIssueTask(task: ProposedIssueTask): string[] {
  const labels = ["director:ready"];

  if (task.kind === "task") {
    labels.push("director:task");
  }

  if (task.execution_mode === "lane") {
    labels.push("director:lane");
  }

  return labels;
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
  draft: SetupRepositoryDraft,
  options?: {
    defaultBranchStrategy?: StoredProjectConfig["defaultBranchStrategy"];
  }
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
    defaultBranchStrategy: options?.defaultBranchStrategy ?? existing?.defaultBranchStrategy ?? null,
    worktreeRoot: draft.worktreeRoot,
    agentRunner: draft.agentRunner,
    createdAt: existing?.createdAt ?? timestamp,
    model: draft.model,
    updatedAt: timestamp
  };
}

type ProjectRepositoryResolution = {
  repoSlug?: string | null;
  repoDefaultBranch?: string | null;
  currentBranch?: string | null;
};

export function reconcileProjectConfigWithRepository(
  projectConfig: StoredProjectConfig,
  resolution: ProjectRepositoryResolution
): {
  nextProjectConfig: StoredProjectConfig;
  changes: string[];
} {
  const nextRepoSlug = resolution.repoSlug?.trim() || projectConfig.repoSlug;
  const repoDefaultBranch = resolution.repoDefaultBranch?.trim() || null;
  const currentBranch = resolution.currentBranch?.trim() || null;
  const nextDefaultBranchStrategy =
    projectConfig.defaultBranchStrategy ??
    (repoDefaultBranch &&
    projectConfig.defaultBranch.trim() &&
    projectConfig.defaultBranch !== repoDefaultBranch &&
    currentBranch === projectConfig.defaultBranch
      ? "custom"
      : "repo_default");

  let nextDefaultBranch = projectConfig.defaultBranch;
  if (!projectConfig.defaultBranch.trim() && repoDefaultBranch) {
    nextDefaultBranch = repoDefaultBranch;
  } else if (repoDefaultBranch && nextDefaultBranchStrategy === "repo_default") {
    nextDefaultBranch = repoDefaultBranch;
  }

  const changes: string[] = [];
  if (nextRepoSlug !== projectConfig.repoSlug) {
    changes.push(`Updated repo slug from ${projectConfig.repoSlug} to ${nextRepoSlug}.`);
  }
  if (nextDefaultBranch !== projectConfig.defaultBranch) {
    changes.push(`Updated base branch from ${projectConfig.defaultBranch} to ${nextDefaultBranch}.`);
  }

  if (
    !changes.length &&
    nextDefaultBranchStrategy === projectConfig.defaultBranchStrategy
  ) {
    return {
      nextProjectConfig: projectConfig,
      changes
    };
  }

  return {
    nextProjectConfig: {
      ...projectConfig,
      repoSlug: nextRepoSlug,
      defaultBranch: nextDefaultBranch,
      defaultBranchStrategy: nextDefaultBranchStrategy,
      updatedAt: nowIso()
    },
    changes
  };
}

async function getCurrentGitBranch(repoPath: string): Promise<string | null> {
  try {
    const branch = await runCommandOrThrow("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath
    });
    const trimmed = branch.trim();
    return trimmed && trimmed !== "HEAD" ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveProjectRepositoryMetadata(
  projectConfig: StoredProjectConfig
): Promise<ProjectRepositoryResolution> {
  const currentBranch = await getCurrentGitBranch(projectConfig.repoPath);
  let detected:
    | Awaited<ReturnType<typeof detectRepoFromPath>>
    | Awaited<ReturnType<typeof fetchRepoDetails>>
    | null = null;
  let probed: Awaited<ReturnType<typeof probeRepositoryPath>> | null = null;

  try {
    detected = await detectRepoFromPath(projectConfig.repoPath);
  } catch {
    try {
      probed = await probeRepositoryPath(projectConfig.repoPath);
    } catch {
      probed = null;
    }

    const fallbackRepoSlug = projectConfig.repoSlug.trim() || probed?.repoSlug || "";
    if (fallbackRepoSlug) {
      try {
        detected = await fetchRepoDetails(fallbackRepoSlug);
      } catch {
        detected = null;
      }
    }
  }

  if (!probed && (!detected?.repoSlug || !detected?.defaultBranch)) {
    try {
      probed = await probeRepositoryPath(projectConfig.repoPath);
    } catch {
      probed = null;
    }
  }

  return {
    repoSlug: detected?.repoSlug || probed?.repoSlug || projectConfig.repoSlug,
    repoDefaultBranch: detected?.defaultBranch || probed?.defaultBranch || null,
    currentBranch
  };
}

async function refreshProjectMetadata(session: ProjectSession): Promise<string[]> {
  const resolution = await resolveProjectRepositoryMetadata(session.projectConfig);
  const { nextProjectConfig, changes } = reconcileProjectConfigWithRepository(
    session.projectConfig,
    resolution
  );

  if (nextProjectConfig === session.projectConfig) {
    return changes;
  }

  const nextConfig = upsertProjectConfig(session.config, nextProjectConfig);
  nextConfig.activeProjectSlug = session.config.activeProjectSlug;
  await saveConfig(nextConfig, session.paths);
  session.config = nextConfig;
  session.projectConfig = nextProjectConfig;
  session.project = projectFromConfig(nextProjectConfig);

  return changes;
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
    let detected:
      | Awaited<ReturnType<typeof detectRepoFromPath>>
      | Awaited<ReturnType<typeof fetchRepoDetails>>
      | null = null;

    try {
      detected = await detectRepoFromPath(resolvedRepo);
    } catch {
      if (probed.repoSlug) {
        try {
          detected = await fetchRepoDetails(probed.repoSlug);
        } catch {
          detected = null;
        }
      }
    }

    const projectName =
      input.projectName?.trim() || detected?.name || probed.name || path.basename(resolvedRepo);

    return {
      draft: {
        repoPath: resolvedRepo,
        projectName,
        repoSlug: detected?.repoSlug || probed.repoSlug,
        defaultBranch: detected?.defaultBranch || probed.defaultBranch || "main",
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
  repositoryDraft: SetupRepositoryDraft,
  options?: {
    defaultBranchStrategy?: StoredProjectConfig["defaultBranchStrategy"];
  }
): Promise<ProjectRecord> {
  const storedProject = draftToStoredProjectConfig(session.config, repositoryDraft, options);
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

function issueOwnerId(router: RouterState, issueNumber: number): string | null {
  const ownerId = router.issueOwnership[String(issueNumber)];
  return typeof ownerId === "string" && ownerId.trim() ? ownerId : null;
}

function findIssueLane(router: RouterState, issueNumber: number): RouterState["lanes"][number] | null {
  const ownerId = issueOwnerId(router, issueNumber);
  if (ownerId === CHIEF_OF_STAFF_OWNER_ID) {
    return null;
  }

  if (ownerId) {
    return findLaneById(router, ownerId);
  }

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

function removeIssueFromLanes(router: RouterState, issueNumber: number): void {
  for (const lane of router.lanes) {
    const before = lane.issueNumbers.length;
    lane.issueNumbers = lane.issueNumbers.filter((candidate) => candidate !== issueNumber);
    if (lane.currentIssueNumber === issueNumber) {
      lane.currentIssueNumber = lane.issueNumbers.at(-1) ?? null;
    }
    if (before !== lane.issueNumbers.length) {
      lane.updatedAt = nowIso();
      if (!lane.issueNumbers.length && lane.status !== "blocked") {
        lane.status = "idle";
      }
    }
  }
}

function assignIssueToLane(
  router: RouterState,
  issueNumber: number,
  laneId: string,
  laneName: string
): RouterLaneState {
  removeIssueFromLanes(router, issueNumber);
  const lane = ensureLane(router, laneId, laneName);
  if (!lane.issueNumbers.includes(issueNumber)) {
    lane.issueNumbers.push(issueNumber);
  }
  lane.currentIssueNumber = issueNumber;
  lane.updatedAt = nowIso();
  router.issueOwnership[String(issueNumber)] = lane.id;
  return lane;
}

function assignIssueToChiefOfStaff(router: RouterState, issueNumber: number): void {
  removeIssueFromLanes(router, issueNumber);
  router.issueOwnership[String(issueNumber)] = CHIEF_OF_STAFF_OWNER_ID;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function commandPathForWorktree(project: ProjectRecord, cwd: string): string {
  const entries = [
    path.join(cwd, "node_modules", ".bin"),
    path.join(project.repoPath, "node_modules", ".bin"),
    process.env.PATH ?? ""
  ].filter(Boolean);

  return entries.join(path.delimiter);
}

async function maybeRunPackageScript(
  project: ProjectRecord,
  cwd: string,
  script: string
): Promise<void> {
  if (!(await pathExists(path.join(cwd, "package.json")))) {
    return;
  }

  await runCommandOrThrow("npm", ["run", script, "--if-present"], {
    cwd,
    env: {
      ...process.env,
      PATH: commandPathForWorktree(project, cwd)
    }
  });
}

async function listGitWorktrees(repoPath: string) {
  const porcelain = await runCommandOrThrow(
    "git",
    ["-C", repoPath, "worktree", "list", "--porcelain"],
    { cwd: repoPath }
  );
  return parseGitWorktreeList(porcelain);
}

async function pruneGitWorktrees(repoPath: string): Promise<void> {
  await runCommandOrThrow("git", ["-C", repoPath, "worktree", "prune"], { cwd: repoPath });
}

async function worktreeHasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const status = await runCommandOrThrow("git", ["-C", worktreePath, "status", "--short"], {
    cwd: worktreePath
  });
  return Boolean(status.trim());
}

async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await runCommandOrThrow(
      "git",
      ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: repoPath }
    );
    return true;
  } catch {
    return false;
  }
}

function suffixedWorktreeTarget(baseValue: string, attempt: number): string {
  return attempt === 0 ? baseValue : `${baseValue}-rerun-${attempt}`;
}

async function resolveFreshIssueWorktreeTarget(
  project: ProjectRecord,
  entries: Awaited<ReturnType<typeof listGitWorktrees>>,
  desiredBranchName: string,
  desiredWorktreePath: string
): Promise<{ branchName: string; worktreePath: string }> {
  const livePaths = new Set(entries.filter((entry) => !entry.isPrunable).map((entry) => entry.path));
  const liveBranches = new Set(
    entries
      .filter((entry) => !entry.isPrunable)
      .flatMap((entry) => (entry.branchName ? [entry.branchName] : []))
  );

  let attempt = 0;
  while (true) {
    const candidateBranchName = suffixedWorktreeTarget(desiredBranchName, attempt);
    const candidateWorktreePath = suffixedWorktreeTarget(desiredWorktreePath, attempt);
    const branchBusy =
      liveBranches.has(candidateBranchName) ||
      (await localBranchExists(project.repoPath, candidateBranchName));
    const pathBusy = livePaths.has(candidateWorktreePath);

    if (!branchBusy && !pathBusy) {
      return {
        branchName: candidateBranchName,
        worktreePath: candidateWorktreePath
      };
    }

    attempt += 1;
  }
}

async function ensureWorktreeNodeModules(
  project: ProjectRecord,
  worktreePath: string
): Promise<void> {
  const sourceNodeModulesPath = path.join(project.repoPath, "node_modules");
  const targetNodeModulesPath = path.join(worktreePath, "node_modules");

  if (!(await pathExists(sourceNodeModulesPath)) || (await pathExists(targetNodeModulesPath))) {
    return;
  }

  try {
    if (process.platform === "win32") {
      await fs.symlink(sourceNodeModulesPath, targetNodeModulesPath, "junction");
    } else {
      await runCommandOrThrow("ln", ["-s", sourceNodeModulesPath, targetNodeModulesPath], {
        cwd: worktreePath
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function resetWorktreeValidationState(worktreePath: string): Promise<void> {
  const transientPaths = [
    "apps/cli/dist",
    "apps/desktop/dist",
    "apps/web/dist",
    "packages/core/dist",
    "packages/shared/dist",
    "apps/cli/tsconfig.tsbuildinfo",
    "apps/desktop/tsconfig.tsbuildinfo",
    "apps/web/tsconfig.tsbuildinfo",
    "packages/core/tsconfig.tsbuildinfo",
    "packages/shared/tsconfig.tsbuildinfo"
  ];

  await Promise.all(
    transientPaths.map((relativePath) =>
      fs.rm(path.join(worktreePath, relativePath), {
        recursive: true,
        force: true
      })
    )
  );
}

async function ensureIssueWorktree(
  project: ProjectRecord,
  issueNumber: number,
  branchName: string,
  worktreePath: string
): Promise<{ branchName: string; worktreePath: string }> {
  await fs.mkdir(project.worktreeRoot, { recursive: true });
  await pruneGitWorktrees(project.repoPath);

  const entries = (await listGitWorktrees(project.repoPath)).filter(
    (entry) =>
      entry.path === worktreePath ||
      entry.path.startsWith(`${project.worktreeRoot}${path.sep}`)
  );

  const reusable = selectReusableGitWorktree(
    entries,
    worktreePath,
    branchName
  );

  if (
    reusable &&
    (await pathExists(reusable.path)) &&
    !(await worktreeHasUncommittedChanges(reusable.path))
  ) {
    await ensureWorktreeNodeModules(project, reusable.path);
    return {
      branchName: reusable.branchName ?? branchName,
      worktreePath: reusable.path
    };
  }

  const target = await resolveFreshIssueWorktreeTarget(project, entries, branchName, worktreePath);

  if (await pathExists(target.worktreePath)) {
    await fs.rm(target.worktreePath, { recursive: true, force: true });
  }

  await runCommandOrThrow(
    "git",
    [
      "-C",
      project.repoPath,
      "worktree",
      "add",
      "-B",
      target.branchName,
      target.worktreePath,
      project.defaultBranch
    ],
    { cwd: project.repoPath }
  );

  await ensureWorktreeNodeModules(project, target.worktreePath);

  return {
    branchName: target.branchName,
    worktreePath: target.worktreePath
  };
}

function branchNameForIssue(issue: GitHubIssueRecord): string {
  return `codex/issue-${issue.number}-${slugify(issue.title).slice(0, 36)}`;
}

function hasPendingLaneWork(router: RouterState, issueNumber: number): boolean {
  return (
    Boolean(issueOwnerId(router, issueNumber)) ||
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
  const ownerId = issueOwnerId(router, issue.number);
  const lane = findIssueLane(router, issue.number);
  const ownerKind =
    ownerId === CHIEF_OF_STAFF_OWNER_ID ? "chief_of_staff" : lane ? "lane" : null;
  const linkedPullRequest =
    pullRequests.find((pullRequest) => pullRequest.linkedIssueNumbers.includes(issue.number)) ?? null;

  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    workflowState: issue.workflowState,
    ownerKind,
    ownerName:
      ownerKind === "chief_of_staff" ? "Chief of Staff" : ownerKind === "lane" ? lane?.name ?? null : null,
    laneId: lane?.id ?? null,
    laneName: lane?.name ?? null,
    executionIntent: lane?.status === "planning" ? "plan" : lane ? "implement" : null,
    status:
      issue.state.toLowerCase() !== "open"
        ? "completed"
      : linkedPullRequest
          ? "waiting_review"
          : ownerKind === "chief_of_staff"
            ? "planned"
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

function synthesizeActivity(router: RouterState): ActivityRecord[] {
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

  return [...questionActivity, ...runActivity]
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
    worktreePath?: string | null;
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
    worktreePath: input.worktreePath ?? null
  });
}

function buildLaneNativePlanPrompt(
  session: ProjectSession,
  lane: RouterLaneState,
  issue: GitHubIssueRecord,
  handoff: RouterHandoffState
): string {
  const handoffSummary = handoff.summary?.trim() || "Chief of Staff routed this issue to your lane.";
  const priorGuidance = parseDataString(handoff.details?.guidance) ?? null;
  const humanGuidance = parseDataString(handoff.details?.human_guidance) ?? null;

  return [
    `/plan Take ownership of GitHub issue #${issue.number}: ${issue.title}.`,
    "Use native Codex plan mode.",
    "Focus on the shortest safe path from this issue to a real PR.",
    "If the issue should be decomposed, include a clearly labeled decomposition section with up to 3 child issue proposals.",
    "If the issue is already bounded, say so explicitly and outline the implementation sequence.",
    "Do not make code changes in this step.",
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

function buildLanePlanSummaryPrompt(
  lane: RouterLaneState,
  issue: GitHubIssueRecord,
  nativePlan: string
): string {
  return [
    "Return structured output only.",
    "Summarize the native lane plan you just produced for the Chief of Staff.",
    "Set `status` to `needs_input` only if the plan uncovered a real product or taste judgment blocker.",
    "If decomposition is warranted, return up to 3 child issues in `data.new_issues`.",
    "Each child issue must include `title`, `body`, `kind`, and `execution_mode`.",
    "If the issue is already bounded, leave `data.new_issues` empty and explain the next implementation step.",
    "Use `data.transcript_reply` for the short update the Chief of Staff should relay back up.",
    "",
    `Lane: ${lane.name} (${lane.id})`,
    `Issue: #${issue.number} ${issue.title}`,
    "",
    "Native plan output:",
    nativePlan.trim() || "No native plan output was captured."
  ].join("\n");
}

function buildLaneImplementationPrompt(
  session: ProjectSession,
  lane: RouterLaneState,
  issue: GitHubIssueRecord,
  handoff: RouterHandoffState
): string {
  const handoffSummary = handoff.summary?.trim() || "Chief of Staff routed this issue to your lane.";
  const priorGuidance = parseDataString(handoff.details?.guidance) ?? null;
  const humanGuidance = parseDataString(handoff.details?.human_guidance) ?? null;
  const worktreePath = parseDataString(handoff.worktreePath) ?? "(missing worktree path)";
  const branchName = parseDataString(handoff.branchName) ?? "(missing branch name)";

  return [
    "You are a persistent lane Codex session owned by the Chief of Staff in Director OS.",
    "Stay within your lane context. Do not address the human directly. The Chief of Staff handles all human-facing communication.",
    "Task: implement this GitHub issue inside the assigned git worktree and leave it ready for commit.",
    "Return structured output only.",
    "Work only inside the assigned worktree path.",
    "Use your existing lane context and any prior plan before editing.",
    "If you are blocked on product or taste judgment, set `status` to `needs_input` and put the exact blocker in `blocking_questions`.",
    "Use `data.transcript_reply` for the short update the Chief of Staff should relay back up.",
    "",
    `Lane: ${lane.name} (${lane.id})`,
    `Issue: #${issue.number} ${issue.title}`,
    `Assigned branch: ${branchName}`,
    `Assigned worktree: ${worktreePath}`,
    "",
    "Chief of Staff handoff:",
    handoffSummary,
    "",
    "Issue body:",
    issue.body.trim() || "No issue body provided.",
    "",
    "Recent CoS conversation:",
    "Use the existing session context plus this explicit handoff. Focus on shipping the bounded slice."
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
  whyItMatters: string | null,
  recommendation: string | null
): Omit<RouterQuestionState, "id" | "createdAt" | "updatedAt"> {
  return {
    title: `Chief of Staff question for #${issue.number}`,
    summary,
    question: blockingQuestion,
    whyItMatters: whyItMatters ?? summary,
    recommendation:
      recommendation ?? "Reply here with the decision you want me to take so I can resume the lane.",
    issueNumber: issue.number,
    prNumber: null,
    runId: null,
    requestedBy: "lane"
  };
}

async function createIssuesFromPlan(
  session: ProjectSession,
  lane: RouterLaneState,
  parentIssue: GitHubIssueRecord,
  tasks: ProposedIssueTask[]
): Promise<Array<{ number: number; title: string; url: string }>> {
  const created: Array<{ number: number; title: string; url: string }> = [];

  for (const task of tasks.slice(0, 3)) {
    const issue = await createIssue(session.project.repoSlug, {
      title: task.title,
      body: `${task.body}\n\nParent issue: #${parentIssue.number}`,
      labels: [...labelsForIssueTask(task), `director:lane:${lane.id}`]
    });

    created.push({
      number: issue.number,
      title: task.title,
      url: issue.url
    });
  }

  if (created.length) {
    await commentOnIssue(
      session.project.repoSlug,
      parentIssue.number,
      [
        `Chief of Staff created ${created.length} child issue${created.length === 1 ? "" : "s"} from lane ${lane.name}'s native plan:`,
        ...created.map((issue) => `- #${issue.number} ${issue.title}`)
      ].join("\n")
    );
  }

  return created;
}

async function syncProjectInternal(session: ProjectSession): Promise<DirectorOperationResponse> {
  const metadataChanges = await refreshProjectMetadata(session);
  const [issues, pullRequests, comments] = await Promise.all([
    listIssues(session.project.repoSlug),
    listPullRequests(session.project.repoSlug),
    listComments(session.project.repoSlug)
  ]);

  const syncedAt = nowIso();
  const summary = [
    `Synced ${issues.length} issues and ${pullRequests.length} pull requests.`,
    ...metadataChanges
  ].join(" ");
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
      lastSummary: summary,
      lastLoopAt: syncedAt
    }
  };
  await saveRouterState(session.paths, nextRouter);

  return {
    ok: true,
    message: summary,
    syncedAt,
    issueCount: issues.length,
    pullRequestCount: pullRequests.length,
    project: session.project
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
  const [router, cache, conversation] = await Promise.all([
    loadRouterState(session.paths, session.project.slug),
    loadGitHubCacheState(session.paths, session.project.slug),
    loadConversationState(session.paths, session.project)
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

  const candidateIssues = cache.issues
    .map((issue) => mapRemoteIssue(session.project, issue))
    .filter((issue) => issue.state.toLowerCase() === "open")
    .filter((issue) => issue.workflowState === "ready" || issue.workflowState === "queued")
    .filter((issue) => !hasPendingLaneWork(router, issue.number));
  const readyIssues = candidateIssues.filter((issue) => issue.workflowState === "ready");
  const issues = (readyIssues.length > 0 ? readyIssues : candidateIssues)
    .filter((issue) => issue.workflowState === "ready" || issue.workflowState === "queued")
    .sort((left, right) => {
      const leftPriority = left.workflowState === "ready" ? 0 : 1;
      const rightPriority = right.workflowState === "ready" ? 0 : 1;
      return leftPriority - rightPriority || left.number - right.number;
    });

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
  const directedIssue = selectDirectedIssue(issues, conversation.messages);
  const preferredIssue = directedIssue ?? fallbackIssue;
  const directorGuidance =
    directedIssue
      ? [...conversation.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "director" &&
              extractIssueNumbers(message.content).includes(directedIssue.number)
          )?.content ?? null
      : null;

  const prompt = buildChiefOfStaffPrompt(COS_TASK_APPENDICES.chooseNextIssue, [
    {
      title: "Director priority",
      content: priorityGuidancePrompt(directedIssue, conversation.messages)
    },
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
    },
    {
      title: "Recent CoS conversation",
      content: truncatePromptSection(
        conversation.messages.length > 0
          ? conversation.messages
              .slice(-6)
              .map((message) => `[${message.role}/${message.kind}] ${message.content}`)
              .join("\n")
          : "No prior conversation."
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
      summary: `Selected issue #${preferredIssue.number} as the next ready slice.`,
      recommended_next_action: "Route the issue into a lane or bounded implementation session.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        selected_issue_number: preferredIssue.number,
        owner_type: "lane",
        execution_intent: defaultExecutionIntentForIssue(preferredIssue),
        lane_id: defaultLaneForIssue(preferredIssue).id,
        lane_name: defaultLaneForIssue(preferredIssue).name,
        guidance: directorGuidance,
        transcript_reply: directedIssue
          ? `I routed issue #${preferredIssue.number} next because the director explicitly prioritized it.`
          : `I routed issue #${preferredIssue.number} next.`
      }
    }
  );

  const requestedIssueNumber = parseDataNumber(turn.result.data?.selected_issue_number) ?? preferredIssue.number;
  const selectionResult =
    directedIssue && requestedIssueNumber !== directedIssue.number
      ? {
          ...turn.result,
          summary: `Respected the director's explicit request to route issue #${directedIssue.number} next.`,
          data: {
            ...(turn.result.data ?? {}),
            selected_issue_number: directedIssue.number,
            guidance: directorGuidance ?? parseDataString(turn.result.data?.guidance),
            transcript_reply:
              parseDataString(turn.result.data?.transcript_reply) ??
              `I routed issue #${directedIssue.number} next because the director explicitly asked for it.`
          }
        }
      : turn.result;
  const selectedIssueNumber =
    parseDataNumber(selectionResult.data?.selected_issue_number) ?? preferredIssue.number;
  const selectedIssue =
    issues.find((issue) => issue.number === selectedIssueNumber) ?? preferredIssue;
  const ownerType = parseDataString(selectionResult.data?.owner_type) ?? "lane";
  const laneFallback = defaultLaneForIssue(selectedIssue);
  const laneId = slugify(parseDataString(selectionResult.data?.lane_id) ?? laneFallback.id);
  const laneName = parseDataString(selectionResult.data?.lane_name) ?? laneFallback.name;
  const executionIntent =
    parseDataString(selectionResult.data?.execution_intent) === "plan"
      ? "plan"
      : defaultExecutionIntentForIssue(selectedIssue);

  const nextRouter = applyChiefOfStaffTurn(session, router, {
    sessionId: turn.sessionId,
    phase: "queue_review",
    result: selectionResult,
    issueNumber: selectedIssue.number
  });
  if (ownerType === CHIEF_OF_STAFF_OWNER_ID) {
    assignIssueToChiefOfStaff(nextRouter, selectedIssue.number);
    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary: `Chief of Staff claimed issue #${selectedIssue.number} for direct handling.`
    };

    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content: `I claimed issue #${selectedIssue.number} for direct Chief of Staff handling.`,
      summary: `Chief of Staff claimed #${selectedIssue.number}`,
      linkedIssueNumber: selectedIssue.number,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });
    return;
  }

  const lane = assignIssueToLane(nextRouter, selectedIssue.number, laneId, laneName);
  lane.currentIssueNumber = selectedIssue.number;
  lane.status = executionIntent === "plan" ? "planning" : "implementing";
  lane.updatedAt = nowIso();
  enqueueHandoff(nextRouter, {
    laneId: lane.id,
    issueNumber: selectedIssue.number,
    kind: executionIntent,
    status: "pending",
    summary:
      parseDataString(selectionResult.data?.transcript_reply) ??
      `Chief of Staff routed issue #${selectedIssue.number} to lane ${lane.name}.`,
    prNumber: null,
    branchName: null,
    worktreePath: null,
    reviewWindowEndsAt: null,
    lastHandledCommentAt: null,
    details:
      parseDataString(selectionResult.data?.guidance) !== null
        ? {
            guidance: parseDataString(selectionResult.data?.guidance)
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
  const reroutedLaneId = slugify(parseDataString(turn.result.data?.lane_id) ?? lane.id);
  const reroutedLaneName = parseDataString(turn.result.data?.lane_name) ?? lane.name;
  const transcriptReply =
    parseDataString(turn.result.data?.transcript_reply) ?? turn.result.summary;

  if (outcome === "answer_worker" || outcome === "reroute") {
    handoff.status = "completed";
    handoff.updatedAt = nowIso();
    const targetLane =
      outcome === "reroute"
        ? assignIssueToLane(nextRouter, issue.number, reroutedLaneId, reroutedLaneName)
        : lane;
    targetLane.status = handoff.kind === "plan" ? "planning" : "implementing";
    targetLane.lastSummary = transcriptReply;
    targetLane.updatedAt = nowIso();
    enqueueHandoff(nextRouter, {
      laneId: targetLane.id,
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
      lastSummary:
        outcome === "reroute"
          ? `Chief of Staff rerouted issue #${issue.number} to lane ${targetLane.name}.`
          : `Chief of Staff resolved a blocker for lane ${lane.name} on issue #${issue.number}.`
    };
    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content:
        outcome === "reroute"
          ? `I rerouted issue #${issue.number} to lane ${targetLane.name} and resumed work there.`
          : `I resolved a blocker for lane ${lane.name} on issue #${issue.number} and resumed the lane.`,
      summary:
        outcome === "reroute"
          ? `Rerouted #${issue.number} to ${targetLane.name}`
          : `Resumed ${lane.name} on #${issue.number}`,
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
    parseDataString(turn.result.data?.why_it_matters),
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

async function reviewLanePlan(
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
  const proposedIssues = parseIssueTasks(laneResult.data?.child_tasks ?? laneResult.data?.new_issues);
  const prompt = buildChiefOfStaffPrompt(COS_TASK_APPENDICES.reviewLanePlan, [
    {
      title: "Lane",
      content: `${lane.name} (${lane.id})`
    },
    {
      title: "Issue",
      content: `#${issue.number}: ${issue.title}\n\n${issue.body.trim() || "No issue body provided."}`
    },
    {
      title: "Lane plan summary",
      content: laneResult.summary
    },
    {
      title: "Lane relay",
      content: parseDataString(laneResult.data?.transcript_reply)
    },
    {
      title: "Proposed child issues",
      content:
        proposedIssues.length > 0
          ? proposedIssues
              .map(
                (task) =>
                  `- ${task.title} [${task.kind}/${task.execution_mode}]\n${summarizeText(task.body, 400)}`
              )
              .join("\n\n")
          : "No child issues proposed."
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
      summary: `Lane ${lane.name} produced a plan for issue #${issue.number}.`,
      recommended_next_action: "Route the issue into implementation or decompose it into child GitHub issues.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        decision: "implement",
        guidance: laneResult.summary,
        transcript_reply:
          parseDataString(laneResult.data?.transcript_reply) ??
          `Lane ${lane.name} produced a plan for issue #${issue.number}.`
      }
    }
  );

  const nextRouter = applyChiefOfStaffTurn(session, router, {
    sessionId: turn.sessionId,
    phase: "plan_review",
    result: turn.result,
    issueNumber: issue.number
  });
  handoff.status = "completed";
  handoff.updatedAt = nowIso();

  const decision = parseDataString(turn.result.data?.decision) ?? "implement";
  const transcriptReply =
    parseDataString(turn.result.data?.transcript_reply) ?? turn.result.summary;
  const guidance = parseDataString(turn.result.data?.guidance) ?? laneResult.summary;

  if (decision === "ask_human") {
    handoff.status = "blocked";
    handoff.updatedAt = nowIso();
    lane.status = "blocked";
    lane.lastSummary = transcriptReply;
    lane.updatedAt = nowIso();

    const questionSeed = blockedQuestionForLane(
      issue,
      turn.result.summary,
      parseDataString(turn.result.data?.question) ??
        `I need a product decision before I decide how to break down issue #${issue.number}.`,
      parseDataString(turn.result.data?.why_it_matters),
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
        "Chief of Staff plan review run should have been recorded."
      ).id
    };
    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary: `Chief of Staff needs human guidance before routing issue #${issue.number}.`
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

  if (decision === "decompose" || decision === "hold") {
    assignIssueToChiefOfStaff(nextRouter, issue.number);
    lane.lastSummary = transcriptReply;
    lane.updatedAt = nowIso();

    const tasks =
      decision === "decompose"
        ? (() => {
            const explicitTasks = parseIssueTasks(turn.result.data?.new_issues);
            return explicitTasks.length > 0 ? explicitTasks : proposedIssues;
          })()
        : [];
    const createdIssues =
      tasks.length > 0 ? await createIssuesFromPlan(session, lane, issue, tasks) : [];

    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary:
        createdIssues.length > 0
          ? `Chief of Staff decomposed issue #${issue.number} into ${createdIssues.length} child issues.`
          : `Chief of Staff is holding issue #${issue.number} after reviewing the lane plan.`
    };

    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content:
        createdIssues.length > 0
          ? `I decomposed issue #${issue.number} into child GitHub issues and kept the parent with the Chief of Staff.`
          : `I kept issue #${issue.number} with the Chief of Staff after reviewing the lane plan.`,
      summary:
        createdIssues.length > 0
          ? `Decomposed #${issue.number} into ${createdIssues.length} child issues`
          : `Held #${issue.number} with Chief of Staff`,
      linkedIssueNumber: issue.number,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });
    return nextRouter;
  }

  const targetLaneId = slugify(parseDataString(turn.result.data?.lane_id) ?? lane.id);
  const targetLaneName = parseDataString(turn.result.data?.lane_name) ?? lane.name;
  const targetLane = assignIssueToLane(nextRouter, issue.number, targetLaneId, targetLaneName);
  targetLane.status = "implementing";
  targetLane.lastSummary = transcriptReply;
  targetLane.updatedAt = nowIso();

  enqueueHandoff(nextRouter, {
    laneId: targetLane.id,
    issueNumber: issue.number,
    kind: "implement",
    status: "pending",
    summary: guidance,
    prNumber: null,
    branchName: null,
    worktreePath: null,
    reviewWindowEndsAt: null,
    lastHandledCommentAt: null,
    details: {
      guidance,
      plan_summary: lane.lastPlanSummary ?? laneResult.summary
    }
  });
  nextRouter.orchestrator = {
    ...nextRouter.orchestrator,
    lastLoopAt: nowIso(),
    lastSummary: `Chief of Staff routed issue #${issue.number} to lane ${targetLane.name} for implementation.`
  };

  await saveRouterState(session.paths, nextRouter);
  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "status_update",
    content: `I reviewed the lane plan for issue #${issue.number} and routed implementation to lane ${targetLane.name}.`,
    summary: `Reviewed plan for #${issue.number}`,
    linkedIssueNumber: issue.number,
    linkedPrNumber: null,
    linkedPullRequestNumber: null,
    isOpenQuestion: false
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

  if (handoff.kind === "plan") {
    const nativePlanTurn = await runCodexSessionTurn({
      role: "lane_owner",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt: buildLaneNativePlanPrompt(session, lane, issue, handoff),
      sessionId: lane.sessionId
    });

    const turn = await runCodexSessionAgent(
      {
        role: "lane_owner",
        cwd: session.project.repoPath,
        model: session.project.model,
        allowWrite: false,
        prompt: buildLanePlanSummaryPrompt(lane, issue, nativePlanTurn.rawMessage),
        sessionId: nativePlanTurn.sessionId
      },
      {
        status: "ok",
        summary: `Lane ${lane.name} completed a native planning pass for issue #${issue.number}.`,
        recommended_next_action: "Route the issue into implementation or decompose it into child GitHub issues.",
        artifact_refs: [],
        blocking_questions: [],
        data: {
          transcript_reply: `Lane ${lane.name} finished a native plan for issue #${issue.number}.`,
          new_issues: []
        },
        raw_model_output: nativePlanTurn.rawMessage
      }
    );

    const laneResult = {
      ...turn.result,
      raw_model_output: nativePlanTurn.rawMessage
    };
    const nextRouter = applyLaneTurn(session, router, lane, {
      sessionId: turn.sessionId ?? nativePlanTurn.sessionId,
      phase: "planning",
      result: laneResult,
      issueNumber: issue.number
    });
    const relay = parseDataString(laneResult.data?.transcript_reply) ?? laneResult.summary;

    if (laneResult.status === "needs_input" || laneResult.blocking_questions.length > 0) {
      handoff.summary = relay;
      handoff.updatedAt = nowIso();
      await mediateLaneBlocker(session, nextRouter, lane, issue, handoff, laneResult);
      return true;
    }

    handoff.summary = relay;
    handoff.updatedAt = nowIso();
    await reviewLanePlan(session, nextRouter, lane, issue, handoff, laneResult);
    return true;
  }

  const ensuredWorktree = await ensureIssueWorktree(
    session.project,
    issue.number,
    handoff.branchName ?? branchNameForIssue(issue),
    handoff.worktreePath ?? path.join(session.project.worktreeRoot, `issue-${issue.number}`)
  );
  handoff.branchName = ensuredWorktree.branchName;
  handoff.worktreePath = ensuredWorktree.worktreePath;
  handoff.updatedAt = nowIso();

  const turn = await runCodexSessionAgent(
    {
      role: "lane_owner",
      cwd: ensuredWorktree.worktreePath,
      model: session.project.model,
      allowWrite: true,
      prompt: buildLaneImplementationPrompt(session, lane, issue, handoff),
      sessionId: lane.sessionId
    },
    {
      status: "ok",
      summary: `Lane ${lane.name} implemented issue #${issue.number}.`,
      recommended_next_action: "Validate the worktree, commit the changes, and open a real pull request.",
      artifact_refs: [ensuredWorktree.worktreePath],
      blocking_questions: [],
      data: {
        transcript_reply: `Lane ${lane.name} finished implementation for issue #${issue.number}.`
      }
    }
  );

  const nextRouter = applyLaneTurn(session, router, lane, {
    sessionId: turn.sessionId,
    phase: handoff.kind,
    result: turn.result,
    issueNumber: issue.number,
    worktreePath: ensuredWorktree.worktreePath
  });
  const relay = parseDataString(turn.result.data?.transcript_reply) ?? turn.result.summary;

  if (turn.result.status === "needs_input" || turn.result.blocking_questions.length > 0) {
    handoff.summary = relay;
    handoff.updatedAt = nowIso();
    await mediateLaneBlocker(session, nextRouter, lane, issue, handoff, turn.result);
    return true;
  }

  try {
    await resetWorktreeValidationState(ensuredWorktree.worktreePath);
    await maybeRunPackageScript(session.project, ensuredWorktree.worktreePath, "typecheck");
    await maybeRunPackageScript(session.project, ensuredWorktree.worktreePath, "build");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handoff.status = "blocked";
    handoff.summary = message;
    handoff.updatedAt = nowIso();
    lane.status = "blocked";
    lane.updatedAt = nowIso();
    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary: `Validation failed for issue #${issue.number}.`
    };
    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content: `Lane ${lane.name} hit a local validation failure on issue #${issue.number}: ${message}`,
      summary: `Validation failed for #${issue.number}`,
      linkedIssueNumber: issue.number,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });
    return true;
  }

  const gitStatus = await runCommandOrThrow("git", ["status", "--short"], {
    cwd: ensuredWorktree.worktreePath
  });
  if (!gitStatus.trim()) {
    handoff.status = "blocked";
    handoff.summary = "Lane implementation completed without producing file changes.";
    handoff.updatedAt = nowIso();
    lane.status = "blocked";
    lane.updatedAt = nowIso();
    nextRouter.orchestrator = {
      ...nextRouter.orchestrator,
      lastLoopAt: nowIso(),
      lastSummary: `Lane ${lane.name} produced no file changes for issue #${issue.number}.`
    };
    await saveRouterState(session.paths, nextRouter);
    await appendConversationMessage(session, {
      role: "chief_of_staff",
      kind: "status_update",
      content: `Lane ${lane.name} completed issue #${issue.number} without producing any file changes.`,
      summary: `No file changes for #${issue.number}`,
      linkedIssueNumber: issue.number,
      linkedPrNumber: null,
      linkedPullRequestNumber: null,
      isOpenQuestion: false
    });
    return true;
  }

  await runCommandOrThrow("git", ["add", "-A"], { cwd: ensuredWorktree.worktreePath });
  await runCommandOrThrow(
    "git",
    [
      "commit",
      "-m",
      `${handoff.prNumber ? "Refine" : "Implement"} #${issue.number}: ${summarizeText(issue.title, 60)}`
    ],
    { cwd: ensuredWorktree.worktreePath }
  );
  await runCommandOrThrow("git", ["push", "-u", "origin", ensuredWorktree.branchName], {
    cwd: ensuredWorktree.worktreePath
  });

  let prNumber = handoff.prNumber;
  let prUrl: string | null = null;
  if (!prNumber) {
    await refreshProjectMetadata(session);
    const createdPullRequest = await createPullRequest(ensuredWorktree.worktreePath, {
      baseBranch: session.project.defaultBranch,
      headBranch: ensuredWorktree.branchName,
      title: issue.title,
      body: [`Fixes #${issue.number}`, "", turn.result.summary].join("\n")
    });
    prNumber = createdPullRequest.number;
    prUrl = createdPullRequest.url;
  }

  const livePullRequest = await viewPullRequest(
    ensuredWorktree.worktreePath,
    assertPresent(prNumber, "PR number missing after lane implementation.")
  );
  handoff.status = "completed";
  handoff.prNumber = livePullRequest.number;
  handoff.reviewWindowEndsAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  handoff.summary = relay;
  handoff.updatedAt = nowIso();
  lane.status = "waiting_review";
  lane.currentIssueNumber = issue.number;
  lane.activePullRequestNumber = livePullRequest.number;
  lane.updatedAt = nowIso();
  nextRouter.orchestrator = {
    ...nextRouter.orchestrator,
    lastLoopAt: nowIso(),
    lastSummary: `Lane ${lane.name} opened PR #${livePullRequest.number} for issue #${issue.number}.`
  };

  await saveRouterState(session.paths, nextRouter);
  await syncProjectInternal(session);

  const refreshedRouter = await loadRouterState(session.paths, session.project.slug);
  await saveRouterState(session.paths, {
    ...refreshedRouter,
    orchestrator: {
      ...refreshedRouter.orchestrator,
      lastSummary: `Lane ${lane.name} opened PR #${livePullRequest.number} for issue #${issue.number}.`
    }
  });
  await appendConversationMessage(session, {
    role: "chief_of_staff",
    kind: "status_update",
    content: [
      `Lane ${lane.name} finished implementation for issue #${issue.number}.`,
      relay,
      `I opened PR #${livePullRequest.number}${prUrl ? ` (${prUrl})` : ""}.`
    ]
      .filter(Boolean)
      .join(" "),
    summary: `Opened PR #${livePullRequest.number} for #${issue.number}`,
    linkedIssueNumber: issue.number,
    linkedPrNumber: livePullRequest.number,
    linkedPullRequestNumber: livePullRequest.number,
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

    const storedProject = await persistProjectRegistration(session, resolvedDraft, {
      defaultBranchStrategy: "repo_default"
    });
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

    const explicitDefaultBranch = options.defaultBranch?.trim() || null;
    const authoritativeDefaultBranch =
      detected?.defaultBranch || discoveredDraft?.defaultBranch || finalDraft.defaultBranch;
    const defaultBranchStrategy =
      explicitDefaultBranch && explicitDefaultBranch !== authoritativeDefaultBranch
        ? "custom"
        : "repo_default";

    const project = await persistProjectRegistration(session, finalDraft, {
      defaultBranchStrategy
    });
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
            whyItMatters: reply.rationale ?? reply.reply,
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
            reply.rationale ?? reply.reply,
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
