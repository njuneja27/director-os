import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";

import {
  DIRECTOR_LABEL_PREFIX,
  type AgentResultEnvelope,
  type DecisionRecord,
  type DecisionsResponse,
  type DirectorNoteRecord,
  type DirectorOperationResponse,
  type DirectorStatusResponse,
  type ExecutionMode,
  type GitHubIssueRecord,
  type GitHubPullRequestRecord,
  type InitCommandOptions,
  type OrchestratorStatus,
  type OrchestratorStatusRecord,
  type PrCycleRecord,
  type ProjectRecord,
  type RunRecord,
  type RunRole,
  type SetupCheck,
  type SetupCheckKind,
  type SetupProblemCode,
  type SetupProbeRepositoryInput,
  type SetupRepositoryDraft,
  type SetupStatusResponse,
  type WorkItemKind,
  type WorkItemRecord,
  type WorkItemStatus
} from "@director-os/shared";

import { probeCodexCli, runCodexAgent } from "./agents.js";
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
import {
  asJson,
  decisionsTable,
  directorNotesTable,
  eventsTable,
  fromJson,
  githubCommentsTable,
  githubIssuesTable,
  githubPullRequestsTable,
  migrateDatabase,
  openDatabase,
  orchestratorStateTable,
  prCyclesTable,
  projectsTable,
  runsTable,
  type DirectorDatabase,
  workItemsTable,
  worktreesTable
} from "./db.js";
import {
  createIssue,
  createPullRequest,
  detectRepoFromPath,
  ensureGhAuthenticated,
  fetchRepoDetails,
  listComments,
  listIssues,
  listPullRequests,
  mergePullRequest,
  probeGhCli,
  probeRepositoryPath,
  pullRequestChecks,
  pullRequestDiff,
  resolveRepoPath,
  viewPullRequest
} from "./github.js";
import {
  inferWorkItemStatus,
  selectActiveWorkItems,
  selectQueuedWorkItems
} from "./work-items.js";

const execFileAsync = promisify(execFile);

const AUTOMATION_WAIT_MS = 10 * 60 * 1000;
const LOOP_INTERVAL_MS = 5 * 1000;

let orchestratorTimer: NodeJS.Timeout | null = null;
let orchestratorRunning = false;

type RuntimeSession = {
  paths: RuntimePaths;
  config: DirectorConfigFile;
  sqlite: Database.Database;
  db: DirectorDatabase;
};

type ProjectSession = RuntimeSession & {
  project: ProjectRecord;
  projectConfig: StoredProjectConfig;
};

function assertPresent<TValue>(value: TValue | null | undefined, message: string): TValue {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });

  return result.stdout.trim();
}

async function withRuntime<TValue>(
  callback: (session: RuntimeSession) => Promise<TValue>
): Promise<TValue> {
  const paths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const config = await loadConfig(paths);
  const store = await openDatabase(paths);
  migrateDatabase(store.sqlite);

  try {
    return await callback({
      paths: store.paths,
      config,
      sqlite: store.sqlite,
      db: store.db
    });
  } finally {
    store.sqlite.close();
  }
}

async function withProject<TValue>(
  callback: (session: ProjectSession) => Promise<TValue>
): Promise<TValue> {
  return withRuntime(async (session) => {
    const slug = session.config.activeProjectSlug;
    if (!slug) {
      throw new Error("No active project is configured. Run `director init` first.");
    }

    const rows = await session.db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.slug, slug))
      .limit(1);
    const row = rows[0];

    if (!row) {
      throw new Error(`Active project '${slug}' is missing from the local database.`);
    }

    const projectConfig = getProjectConfig(session.config, slug);

    if (!projectConfig) {
      throw new Error(`Active project '${slug}' is missing from the runtime config.`);
    }

    return callback({
      ...session,
      project: mapProjectRow(row),
      projectConfig
    });
  });
}

function mapProjectRow(row: typeof projectsTable.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repoPath: row.repoPath,
    repoSlug: row.repoSlug,
    defaultBranch: row.defaultBranch,
    worktreeRoot: row.worktreeRoot,
    agentRunner: row.agentRunner,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapGitHubIssueRow(row: typeof githubIssuesTable.$inferSelect): GitHubIssueRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    workflowState: row.workflowState,
    labels: fromJson(row.labels as string[]),
    url: row.url,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt
  };
}

function mapGitHubPullRequestRow(
  row: typeof githubPullRequestsTable.$inferSelect
): GitHubPullRequestRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    isDraft: row.isDraft,
    reviewDecision: row.reviewDecision ?? null,
    checksBucket: row.checksBucket ?? null,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    url: row.url,
    linkedIssueNumbers: fromJson(row.linkedIssueNumbers as number[]),
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt
  };
}

function mapWorkItemRow(row: typeof workItemsTable.$inferSelect): WorkItemRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    issueNumber: row.issueNumber,
    parentIssueNumber: row.parentIssueNumber ?? null,
    title: row.title,
    summary: row.summary,
    kind: row.kind as WorkItemKind,
    executionMode: row.executionMode as ExecutionMode,
    ownerRole: row.ownerRole,
    status: row.status as WorkItemStatus,
    priorityBucket: row.priorityBucket,
    activeRunId: row.activeRunId ?? null,
    activePrNumber: row.activePrNumber ?? null,
    lastSummary: row.lastSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapRunRow(row: typeof runsTable.$inferSelect): RunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    workItemId: row.workItemId ?? null,
    issueNumber: row.issueNumber ?? null,
    prNumber: row.prNumber ?? null,
    role: row.role as RunRole,
    status: row.status as RunRecord["status"],
    phase: row.phase,
    summary: row.summary,
    recommendedNextAction: row.recommendedNextAction ?? null,
    artifacts: fromJson(row.artifacts as string[]),
    blockingQuestions: fromJson(row.blockingQuestions as string[]),
    outputJson: row.outputJson ? fromJson(row.outputJson as Record<string, unknown>) : null,
    worktreePath: row.worktreePath ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapDecisionRow(row: typeof decisionsTable.$inferSelect): DecisionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    workItemId: row.workItemId ?? null,
    issueNumber: row.issueNumber ?? null,
    prNumber: row.prNumber ?? null,
    target: row.target as DecisionRecord["target"],
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    rationale: row.rationale,
    status: row.status as DecisionRecord["status"],
    resolution: row.resolution ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapNoteRow(row: typeof directorNotesTable.$inferSelect): DirectorNoteRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    content: row.content,
    status: row.status as DirectorNoteRecord["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapPrCycleRow(row: typeof prCyclesTable.$inferSelect): PrCycleRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    status: row.status as PrCycleRecord["status"],
    summary: row.summary,
    automationWindowEndsAt: row.automationWindowEndsAt ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    lastHandledCommentAt: row.lastHandledCommentAt ?? null,
    mergedAt: row.mergedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapOrchestratorRow(
  row: typeof orchestratorStateTable.$inferSelect
): OrchestratorStatusRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as OrchestratorStatus,
    pauseReason: row.pauseReason ?? null,
    activeRunIds: fromJson(row.activeRunIds as number[]),
    lastLoopAt: row.lastLoopAt ?? null,
    lastSummary: row.lastSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function setupTitle(kind: SetupCheckKind): string {
  switch (kind) {
    case "repository":
      return "Repository";
    case "github":
      return "GitHub CLI";
    case "codex":
      return "Coding engine";
    case "workspace":
      return "Workspace test";
    default:
      return "Setup";
  }
}

function makeSetupCheck(
  kind: SetupCheckKind,
  status: SetupCheck["status"],
  detail: string,
  options: {
    code?: SetupProblemCode | null;
    recommendedAction?: string | null;
    advancedDetail?: string | null;
  } = {}
): SetupCheck {
  return {
    kind,
    status,
    title: setupTitle(kind),
    detail,
    code: options.code ?? null,
    recommendedAction: options.recommendedAction ?? null,
    advancedDetail: options.advancedDetail ?? null
  };
}

function waitingSetupCheck(kind: SetupCheckKind, detail: string): SetupCheck {
  return makeSetupCheck(kind, "waiting", detail);
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

function draftToStoredProjectConfig(draft: SetupRepositoryDraft): StoredProjectConfig {
  return {
    name: draft.projectName,
    slug: slugify(draft.projectName),
    repoPath: draft.repoPath,
    repoSlug: draft.repoSlug,
    defaultBranch: draft.defaultBranch,
    worktreeRoot: draft.worktreeRoot,
    agentRunner: draft.agentRunner,
    model: draft.model,
    updatedAt: nowIso()
  };
}

async function getActiveProjectFromRuntime(session: RuntimeSession): Promise<ProjectRecord | null> {
  const slug = session.config.activeProjectSlug;

  if (!slug) {
    return null;
  }

  const rows = await session.db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.slug, slug))
    .limit(1);

  return rows[0] ? mapProjectRow(rows[0]) : null;
}

async function buildRepositoryDraft(
  input: SetupProbeRepositoryInput,
  paths: RuntimePaths
): Promise<{ draft: SetupRepositoryDraft | null; check: SetupCheck }> {
  const rawPath = input.repoPath.trim();

  if (!rawPath) {
    return {
      draft: null,
      check: makeSetupCheck(
        "repository",
        "needs_action",
        "Choose the local repository Director OS should operate on.",
        {
          code: "repo_missing",
          recommendedAction: "Enter the absolute path to a local git checkout."
        }
      )
    };
  }

  if (!path.isAbsolute(rawPath)) {
    return {
      draft: null,
      check: makeSetupCheck("repository", "needs_action", "Repository path must be absolute.", {
        code: "repo_not_absolute",
        recommendedAction: "Use the full local path, starting with `/`."
      })
    };
  }

  try {
    const detected = await probeRepositoryPath(rawPath);
    const projectName = input.projectName?.trim() || detected.name || path.basename(detected.repoPath);
    const draft: SetupRepositoryDraft = {
      repoPath: detected.repoPath,
      projectName,
      repoSlug: detected.repoSlug,
      defaultBranch: detected.defaultBranch,
      worktreeRoot: path.resolve(
        input.worktreeRoot?.trim() || path.join(paths.worktreesDir, slugify(projectName))
      ),
      agentRunner: "codex",
      model: input.model?.trim() || "gpt-5.4"
    };

    if (!draft.repoSlug) {
      return {
        draft,
        check: makeSetupCheck(
          "repository",
          "needs_action",
          "The repository is valid, but the GitHub remote could not be inferred.",
          {
            code: "repo_slug_missing",
            recommendedAction: "Add an `origin` remote that points at GitHub, then re-check.",
            advancedDetail: `Checked repo path: ${draft.repoPath}`
          }
        )
      };
    }

    if (!draft.defaultBranch) {
      return {
        draft,
        check: makeSetupCheck(
          "repository",
          "needs_action",
          "The repository is valid, but the default branch could not be inferred.",
          {
            code: "default_branch_missing",
            recommendedAction:
              "Set the repo's default branch locally or fetch the remote HEAD, then re-check.",
            advancedDetail: `Repository: ${draft.repoPath}`
          }
        )
      };
    }

    return {
      draft,
      check: makeSetupCheck(
        "repository",
        "ready",
        `${draft.repoSlug} on ${draft.defaultBranch} is ready for setup.`,
        {
          recommendedAction: "Continue to the environment checks."
        }
      )
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errno = error as NodeJS.ErrnoException;

    if (errno.code === "ENOENT") {
      return {
        draft: null,
        check: makeSetupCheck("repository", "needs_action", "That repository path does not exist.", {
          code: "repo_not_found",
          recommendedAction: "Confirm the path and try again.",
          advancedDetail: message
        })
      };
    }

    if (/not a directory/i.test(message)) {
      return {
        draft: null,
        check: makeSetupCheck("repository", "needs_action", "That path is not a directory.", {
          code: "repo_not_found",
          recommendedAction: "Point Director OS at a local repository folder.",
          advancedDetail: message
        })
      };
    }

    return {
      draft: null,
      check: makeSetupCheck("repository", "needs_action", "That folder is not a git repository.", {
        code: "repo_not_git",
        recommendedAction: "Choose a local git checkout with a GitHub remote.",
        advancedDetail: message
      })
    };
  }
}

async function evaluateSetupState(
  session: RuntimeSession,
  options: {
    activeProject: ProjectRecord | null;
    repositoryDraft: SetupRepositoryDraft | null;
    repositoryCheck?: SetupCheck;
    runWorkspace: boolean;
  }
): Promise<SetupStatusResponse> {
  const repositoryCheck =
    options.repositoryCheck ??
    (options.repositoryDraft
      ? makeSetupCheck(
          "repository",
          "ready",
          `${options.repositoryDraft.repoSlug} on ${options.repositoryDraft.defaultBranch} is ready for setup.`
        )
      : makeSetupCheck("repository", "needs_action", "Choose the repository Director OS should operate on.", {
          code: "repo_missing",
          recommendedAction: "Enter the absolute path to a local repository."
        }));

  const githubProbe = await probeGhCli();
  const githubCheck =
    repositoryCheck.status !== "ready"
      ? waitingSetupCheck("github", "Repository details are required before GitHub can be verified.")
      : githubProbe.ok
        ? makeSetupCheck("github", "ready", githubProbe.detail)
        : makeSetupCheck(
            "github",
            githubProbe.reason === "missing" || githubProbe.reason === "auth_required"
              ? "needs_action"
              : "blocked",
            githubProbe.detail,
            {
              code:
                githubProbe.reason === "missing"
                  ? "gh_missing"
                  : githubProbe.reason === "auth_required"
                    ? "gh_auth_required"
                    : "gh_probe_failed",
              recommendedAction:
                githubProbe.reason === "missing"
                  ? "Install GitHub CLI and sign in."
                  : githubProbe.reason === "auth_required"
                    ? "Run `gh auth login`, then re-check."
                    : "Inspect the diagnostic details, then re-check.",
              advancedDetail: githubProbe.advancedDetail
            }
          );

  const codexProbe = await probeCodexCli(options.repositoryDraft?.model ?? "gpt-5.4");
  const codexCheck = codexProbe.ok
    ? makeSetupCheck("codex", "ready", codexProbe.detail)
    : makeSetupCheck(
        "codex",
        codexProbe.reason === "missing" || codexProbe.reason === "auth_required"
          ? "needs_action"
          : "blocked",
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
              ? "Install Codex, then re-check."
              : codexProbe.reason === "auth_required"
                ? "Sign in to Codex, then re-check."
                : "Inspect the diagnostic details, then re-check.",
          advancedDetail: codexProbe.advancedDetail
        }
      );

  let workspaceCheck = waitingSetupCheck(
    "workspace",
    "Run the local workspace test after the repository and integrations are ready."
  );

  if (
    options.runWorkspace &&
    options.repositoryDraft &&
    repositoryCheck.status === "ready" &&
    githubCheck.status === "ready" &&
    codexCheck.status === "ready"
  ) {
    try {
      await ensureRuntimeDirectories(session.paths);
      await fs.mkdir(options.repositoryDraft.worktreeRoot, { recursive: true });
      await fs.access(options.repositoryDraft.repoPath);
      await fs.access(session.paths.databasePath).catch(async () => {
        await fs.writeFile(session.paths.databasePath, "", "utf8");
      });
      workspaceCheck = makeSetupCheck(
        "workspace",
        "ready",
        "Runtime storage, SQLite, repository access, and the local worktree root are ready."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workspaceCheck = makeSetupCheck(
        "workspace",
        "blocked",
        "The local workspace test failed.",
        {
          code: "workspace_probe_failed",
          recommendedAction: "Inspect the diagnostic details, fix the local environment, then re-check.",
          advancedDetail: message
        }
      );
    }
  }

  const checks = [repositoryCheck, githubCheck, codexCheck, workspaceCheck];

  return {
    activeProject: options.activeProject,
    checks,
    repositoryDraft: options.repositoryDraft,
    canComplete: checks.every((check) => check.status === "ready"),
    completed:
      Boolean(options.activeProject) && checks.every((check) => check.status === "ready")
  };
}

async function persistProjectRegistration(
  session: RuntimeSession,
  draft: SetupRepositoryDraft
): Promise<ProjectRecord> {
  const storedProject = draftToStoredProjectConfig(draft);
  const timestamp = nowIso();
  const existingRows = await session.db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.slug, storedProject.slug))
    .limit(1);

  if (existingRows[0]) {
    await session.db
      .update(projectsTable)
      .set({
        name: storedProject.name,
        repoPath: storedProject.repoPath,
        repoSlug: storedProject.repoSlug,
        defaultBranch: storedProject.defaultBranch,
        worktreeRoot: storedProject.worktreeRoot,
        agentRunner: storedProject.agentRunner,
        model: storedProject.model,
        updatedAt: timestamp
      })
      .where(eq(projectsTable.id, existingRows[0].id));
  } else {
    await session.db.insert(projectsTable).values({
      name: storedProject.name,
      slug: storedProject.slug,
      repoPath: storedProject.repoPath,
      repoSlug: storedProject.repoSlug,
      defaultBranch: storedProject.defaultBranch,
      worktreeRoot: storedProject.worktreeRoot,
      agentRunner: storedProject.agentRunner,
      model: storedProject.model,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  const nextConfig = upsertProjectConfig(session.config, storedProject);
  nextConfig.activeProjectSlug = storedProject.slug;
  await saveConfig(nextConfig, session.paths);

  const rows = await session.db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.slug, storedProject.slug))
    .limit(1);
  const project = mapProjectRow(assertPresent(rows[0], "Registered project row is missing."));

  await ensureOrchestratorRow({
    ...session,
    project,
    projectConfig: storedProject
  });

  return project;
}

function summarizeText(value: string, maxLength = 280): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function labelFor(suffix: string): string {
  return `${DIRECTOR_LABEL_PREFIX}${suffix}`;
}

function inferWorkflowState(labels: string[], state: string): string {
  if (state.toLowerCase() !== "open") {
    return "done";
  }

  if (labels.includes(labelFor("ready"))) {
    return "ready";
  }

  if (labels.includes(labelFor("blocked"))) {
    return "blocked";
  }

  if (labels.includes(labelFor("in-review"))) {
    return "in_review";
  }

  return "queued";
}

function inferWorkItemKind(issue: GitHubIssueRecord): WorkItemKind {
  return issue.labels.includes(labelFor("workstream")) || /^epic:/i.test(issue.title)
    ? "workstream"
    : "task";
}

function inferExecutionMode(kind: WorkItemKind, issue: GitHubIssueRecord): ExecutionMode {
  if (issue.labels.includes(labelFor("lane"))) {
    return "lane";
  }

  if (issue.labels.includes(labelFor("worker"))) {
    return "worker";
  }

  return kind === "workstream" ? "lane" : "worker";
}

function inferPriorityBucket(status: WorkItemStatus): number {
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
    case "completed":
      return 5;
    default:
      return 3;
  }
}

async function recordEvent(
  db: DirectorDatabase,
  projectId: number,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  await db.insert(eventsTable).values({
    projectId,
    kind,
    payload: asJson(payload),
    createdAt: nowIso()
  });
}

async function maybeRunPackageScript(cwd: string, script: string): Promise<void> {
  try {
    await fs.access(path.join(cwd, "package.json"));
  } catch {
    return;
  }

  await runCommand("npm", ["run", script, "--if-present"], cwd);
}

async function ensureWorktree(
  project: ProjectRecord,
  issueNumber: number,
  branchName: string,
  worktreePath: string
): Promise<void> {
  await fs.mkdir(project.worktreeRoot, { recursive: true });

  try {
    await fs.access(worktreePath);
    return;
  } catch {
    await runCommand(
      "git",
      ["-C", project.repoPath, "worktree", "add", "-B", branchName, worktreePath, project.defaultBranch],
      project.repoPath
    );
  }
}

async function upsertGitHubIssueMirror(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<GitHubIssueRecord, "id" | "projectId">
): Promise<void> {
  const existing = await db
    .select()
    .from(githubIssuesTable)
    .where(eq(githubIssuesTable.projectId, projectId));
  const row = existing.find((candidate) => candidate.number === input.number);

  if (row) {
    await db
      .update(githubIssuesTable)
      .set({
        title: input.title,
        body: input.body,
        state: input.state,
        workflowState: input.workflowState,
        labels: asJson(input.labels),
        url: input.url,
        updatedAt: input.updatedAt,
        syncedAt: input.syncedAt
      })
      .where(eq(githubIssuesTable.id, row.id));
    return;
  }

  await db.insert(githubIssuesTable).values({
    projectId,
    number: input.number,
    title: input.title,
    body: input.body,
    state: input.state,
    workflowState: input.workflowState,
    labels: asJson(input.labels),
    url: input.url,
    updatedAt: input.updatedAt,
    syncedAt: input.syncedAt
  });
}

async function upsertGitHubPullRequestMirror(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<GitHubPullRequestRecord, "id" | "projectId">
): Promise<void> {
  const existing = await db
    .select()
    .from(githubPullRequestsTable)
    .where(eq(githubPullRequestsTable.projectId, projectId));
  const row = existing.find((candidate) => candidate.number === input.number);

  if (row) {
    await db
      .update(githubPullRequestsTable)
      .set({
        title: input.title,
        body: input.body,
        state: input.state,
        isDraft: input.isDraft,
        reviewDecision: input.reviewDecision,
        checksBucket: input.checksBucket,
        headRefName: input.headRefName,
        baseRefName: input.baseRefName,
        url: input.url,
        linkedIssueNumbers: asJson(input.linkedIssueNumbers),
        updatedAt: input.updatedAt,
        syncedAt: input.syncedAt
      })
      .where(eq(githubPullRequestsTable.id, row.id));
    return;
  }

  await db.insert(githubPullRequestsTable).values({
    projectId,
    number: input.number,
    title: input.title,
    body: input.body,
    state: input.state,
    isDraft: input.isDraft,
    reviewDecision: input.reviewDecision,
    checksBucket: input.checksBucket,
    headRefName: input.headRefName,
    baseRefName: input.baseRefName,
    url: input.url,
    linkedIssueNumbers: asJson(input.linkedIssueNumbers),
    updatedAt: input.updatedAt,
    syncedAt: input.syncedAt
  });
}

async function upsertGitHubCommentMirror(
  db: DirectorDatabase,
  projectId: number,
  input: {
    githubId: string;
    parentType: "issue" | "pr";
    parentNumber: number;
    author: string;
    body: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    syncedAt: string;
  }
): Promise<void> {
  const rows = await db
    .select()
    .from(githubCommentsTable)
    .where(eq(githubCommentsTable.projectId, projectId));
  const row = rows.find((candidate) => candidate.githubId === input.githubId);

  if (row) {
    await db
      .update(githubCommentsTable)
      .set({
        parentType: input.parentType,
        parentNumber: input.parentNumber,
        author: input.author,
        body: input.body,
        url: input.url,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        syncedAt: input.syncedAt
      })
      .where(eq(githubCommentsTable.id, row.id));
    return;
  }

  await db.insert(githubCommentsTable).values({
    projectId,
    githubId: input.githubId,
    parentType: input.parentType,
    parentNumber: input.parentNumber,
    author: input.author,
    body: input.body,
    url: input.url,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    syncedAt: input.syncedAt
  });
}

async function getWorkItemByIssueNumber(
  db: DirectorDatabase,
  projectId: number,
  issueNumber: number
): Promise<WorkItemRecord | null> {
  const rows = await db
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.projectId, projectId));
  const row = rows.find((candidate) => candidate.issueNumber === issueNumber);
  return row ? mapWorkItemRow(row) : null;
}

async function upsertWorkItem(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<WorkItemRecord, "id" | "projectId" | "createdAt" | "updatedAt">
): Promise<WorkItemRecord> {
  const rows = await db
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.projectId, projectId));
  const row = rows.find((candidate) => candidate.issueNumber === input.issueNumber);
  const timestamp = nowIso();

  if (row) {
    await db
      .update(workItemsTable)
      .set({
        parentIssueNumber: input.parentIssueNumber,
        title: input.title,
        summary: input.summary,
        kind: input.kind,
        executionMode: input.executionMode,
        ownerRole: input.ownerRole,
        status: input.status,
        priorityBucket: input.priorityBucket,
        activeRunId: input.activeRunId,
        activePrNumber: input.activePrNumber,
        lastSummary: input.lastSummary,
        updatedAt: timestamp
      })
      .where(eq(workItemsTable.id, row.id));
  } else {
    await db.insert(workItemsTable).values({
      projectId,
      issueNumber: input.issueNumber,
      parentIssueNumber: input.parentIssueNumber,
      title: input.title,
      summary: input.summary,
      kind: input.kind,
      executionMode: input.executionMode,
      ownerRole: input.ownerRole,
      status: input.status,
      priorityBucket: input.priorityBucket,
      activeRunId: input.activeRunId,
      activePrNumber: input.activePrNumber,
      lastSummary: input.lastSummary,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  return assertPresent(
    await getWorkItemByIssueNumber(db, projectId, input.issueNumber),
    `Work item for issue #${input.issueNumber} is missing after upsert.`
  );
}

async function insertRun(
  session: ProjectSession,
  input: Omit<RunRecord, "id" | "projectId" | "createdAt" | "updatedAt">
): Promise<RunRecord> {
  const timestamp = nowIso();
  const result = await session.db.insert(runsTable).values({
    projectId: session.project.id,
    workItemId: input.workItemId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    role: input.role,
    status: input.status,
    phase: input.phase,
    summary: input.summary,
    recommendedNextAction: input.recommendedNextAction,
    artifacts: asJson(input.artifacts),
    blockingQuestions: asJson(input.blockingQuestions),
    outputJson: input.outputJson ? asJson(input.outputJson) : null,
    worktreePath: input.worktreePath,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const row = await session.db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, Number(result.lastInsertRowid)))
    .limit(1);
  const mapped = mapRunRow(assertPresent(row[0], "Run row missing after insert."));
  await syncOrchestratorActiveRuns(session);
  return mapped;
}

async function updateRun(
  session: ProjectSession,
  runId: number,
  patch: Partial<Omit<RunRecord, "id" | "projectId" | "createdAt">>
): Promise<RunRecord> {
  await session.db
    .update(runsTable)
    .set({
      workItemId: patch.workItemId,
      issueNumber: patch.issueNumber,
      prNumber: patch.prNumber,
      role: patch.role,
      status: patch.status,
      phase: patch.phase,
      summary: patch.summary,
      recommendedNextAction: patch.recommendedNextAction,
      artifacts: patch.artifacts ? asJson(patch.artifacts) : undefined,
      blockingQuestions: patch.blockingQuestions ? asJson(patch.blockingQuestions) : undefined,
      outputJson: patch.outputJson ? asJson(patch.outputJson) : patch.outputJson === null ? null : undefined,
      worktreePath: patch.worktreePath,
      updatedAt: nowIso()
    })
    .where(eq(runsTable.id, runId));

  const row = await session.db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  const mapped = mapRunRow(assertPresent(row[0], `Run ${runId} is missing after update.`));
  await syncOrchestratorActiveRuns(session);
  return mapped;
}

async function createDecision(
  session: ProjectSession,
  input: Omit<DecisionRecord, "id" | "projectId" | "createdAt" | "updatedAt" | "status" | "resolution">
): Promise<DecisionRecord> {
  const timestamp = nowIso();
  const result = await session.db.insert(decisionsTable).values({
    projectId: session.project.id,
    workItemId: input.workItemId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    target: input.target,
    title: input.title,
    summary: input.summary,
    recommendation: input.recommendation,
    rationale: input.rationale,
    status: "open",
    resolution: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const row = await session.db
    .select()
    .from(decisionsTable)
    .where(eq(decisionsTable.id, Number(result.lastInsertRowid)))
    .limit(1);
  return mapDecisionRow(assertPresent(row[0], "Decision row missing after insert."));
}

async function upsertPrCycle(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<PrCycleRecord, "id" | "projectId" | "createdAt" | "updatedAt">
): Promise<PrCycleRecord> {
  const rows = await db.select().from(prCyclesTable).where(eq(prCyclesTable.projectId, projectId));
  const row = rows.find((candidate) => candidate.prNumber === input.prNumber);
  const timestamp = nowIso();

  if (row) {
    await db
      .update(prCyclesTable)
      .set({
        issueNumber: input.issueNumber,
        status: input.status,
        summary: input.summary,
        automationWindowEndsAt: input.automationWindowEndsAt,
        lastCheckedAt: input.lastCheckedAt,
        lastHandledCommentAt: input.lastHandledCommentAt,
        mergedAt: input.mergedAt,
        updatedAt: timestamp
      })
      .where(eq(prCyclesTable.id, row.id));
  } else {
    await db.insert(prCyclesTable).values({
      projectId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      status: input.status,
      summary: input.summary,
      automationWindowEndsAt: input.automationWindowEndsAt,
      lastCheckedAt: input.lastCheckedAt,
      lastHandledCommentAt: input.lastHandledCommentAt,
      mergedAt: input.mergedAt,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  const currentRows = await db.select().from(prCyclesTable).where(eq(prCyclesTable.projectId, projectId));
  return mapPrCycleRow(
    assertPresent(
      currentRows.find((candidate) => candidate.prNumber === input.prNumber),
      `PR cycle ${input.prNumber} is missing after upsert.`
    )
  );
}

async function ensureOrchestratorRow(session: ProjectSession): Promise<OrchestratorStatusRecord> {
  const rows = await session.db
    .select()
    .from(orchestratorStateTable)
    .where(eq(orchestratorStateTable.projectId, session.project.id))
    .limit(1);
  const existing = rows[0];

  if (existing) {
    return mapOrchestratorRow(existing);
  }

  const timestamp = nowIso();
  await session.db.insert(orchestratorStateTable).values({
    projectId: session.project.id,
    status: "idle",
    pauseReason: null,
    activeRunIds: asJson([]),
    lastLoopAt: null,
    lastSummary: "Orchestrator has not started yet.",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const current = await session.db
    .select()
    .from(orchestratorStateTable)
    .where(eq(orchestratorStateTable.projectId, session.project.id))
    .limit(1);
  return mapOrchestratorRow(assertPresent(current[0], "Orchestrator row missing after insert."));
}

async function syncOrchestratorActiveRuns(session: ProjectSession): Promise<void> {
  const orchestrator = await ensureOrchestratorRow(session);
  const runningRows = await session.db
    .select()
    .from(runsTable)
    .where(eq(runsTable.projectId, session.project.id));
  const activeRunIds = runningRows
    .filter((candidate) => candidate.status === "running")
    .map((candidate) => candidate.id);

  await session.db
    .update(orchestratorStateTable)
    .set({
      activeRunIds: asJson(activeRunIds),
      updatedAt: nowIso()
    })
    .where(eq(orchestratorStateTable.id, orchestrator.id));
}

async function setOrchestratorState(
  session: ProjectSession,
  status: OrchestratorStatus,
  options: {
    pauseReason?: string | null;
    lastSummary?: string | null;
    lastLoopAt?: string | null;
  } = {}
): Promise<OrchestratorStatusRecord> {
  const current = await ensureOrchestratorRow(session);
  await session.db
    .update(orchestratorStateTable)
    .set({
      status,
      pauseReason: options.pauseReason === undefined ? current.pauseReason : options.pauseReason,
      lastSummary: options.lastSummary === undefined ? current.lastSummary : options.lastSummary,
      lastLoopAt: options.lastLoopAt === undefined ? current.lastLoopAt : options.lastLoopAt,
      updatedAt: nowIso()
    })
    .where(eq(orchestratorStateTable.id, current.id));

  const row = await session.db
    .select()
    .from(orchestratorStateTable)
    .where(eq(orchestratorStateTable.id, current.id))
    .limit(1);
  return mapOrchestratorRow(assertPresent(row[0], "Orchestrator row missing after update."));
}

async function getOpenPullRequests(
  session: ProjectSession
): Promise<GitHubPullRequestRecord[]> {
  const rows = await session.db
    .select()
    .from(githubPullRequestsTable)
    .where(eq(githubPullRequestsTable.projectId, session.project.id));
  return rows
    .map(mapGitHubPullRequestRow)
    .filter((pullRequest) => pullRequest.state.toLowerCase() === "open");
}

async function seedWorkItemsFromGitHub(session: ProjectSession): Promise<void> {
  const issueRows = await session.db
    .select()
    .from(githubIssuesTable)
    .where(eq(githubIssuesTable.projectId, session.project.id));
  const issues = issueRows.map(mapGitHubIssueRow);
  const pullRequests = await getOpenPullRequests(session);
  const existingRows = await session.db
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.projectId, session.project.id));
  const existingMap = new Map(existingRows.map((row) => [row.issueNumber, mapWorkItemRow(row)]));

  for (const issue of issues) {
    const linkedPr =
      pullRequests.find((pullRequest) => pullRequest.linkedIssueNumbers.includes(issue.number)) ?? null;
    const existing = existingMap.get(issue.number) ?? null;
    const kind = existing?.kind ?? inferWorkItemKind(issue);
    const executionMode = existing?.executionMode ?? inferExecutionMode(kind, issue);
    const status = inferWorkItemStatus(issue, existing, linkedPr);
    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: issue.number,
      parentIssueNumber: existing?.parentIssueNumber ?? null,
      title: issue.title,
      summary: summarizeText(issue.body || issue.title),
      kind,
      executionMode,
      ownerRole: executionMode === "lane" ? "lane_owner" : "worker",
      status,
      priorityBucket: inferPriorityBucket(status),
      activeRunId: existing?.activeRunId ?? null,
      activePrNumber: linkedPr?.number ?? null,
      lastSummary: existing?.lastSummary ?? null
    });
  }

  await refreshWorkstreamStatuses(session);
}

async function refreshWorkstreamStatuses(session: ProjectSession): Promise<void> {
  const rows = await session.db
    .select()
    .from(workItemsTable)
    .where(eq(workItemsTable.projectId, session.project.id));
  const workItems = rows.map(mapWorkItemRow);
  const parents = workItems.filter((workItem) => workItem.kind === "workstream");

  for (const parent of parents) {
    const children = workItems.filter((workItem) => workItem.parentIssueNumber === parent.issueNumber);
    if (!children.length) {
      continue;
    }

    let status: WorkItemStatus = "running";
    if (children.every((child) => child.status === "completed")) {
      status = "completed";
    } else if (children.some((child) => child.status === "waiting_decision")) {
      status = "waiting_decision";
    } else if (children.some((child) => child.status === "blocked")) {
      status = "blocked";
    }

    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: parent.issueNumber,
      parentIssueNumber: parent.parentIssueNumber,
      title: parent.title,
      summary: parent.summary,
      kind: parent.kind,
      executionMode: parent.executionMode,
      ownerRole: parent.ownerRole,
      status,
      priorityBucket: inferPriorityBucket(status),
      activeRunId: parent.activeRunId,
      activePrNumber: parent.activePrNumber,
      lastSummary: parent.lastSummary
    });
  }
}

async function syncPrCyclesFromGitHub(session: ProjectSession): Promise<void> {
  const pullRequests = await getOpenPullRequests(session);
  const workItems = (
    await session.db
      .select()
      .from(workItemsTable)
      .where(eq(workItemsTable.projectId, session.project.id))
  ).map(mapWorkItemRow);
  const activePrNumbers = new Set<number>();

  for (const pullRequest of pullRequests) {
    const issueNumber = pullRequest.linkedIssueNumbers[0];
    if (!issueNumber) {
      continue;
    }
    activePrNumbers.add(pullRequest.number);
    const existingWorkItem = workItems.find((candidate) => candidate.issueNumber === issueNumber);
    if (existingWorkItem) {
      await upsertWorkItem(session.db, session.project.id, {
        issueNumber: existingWorkItem.issueNumber,
        parentIssueNumber: existingWorkItem.parentIssueNumber,
        title: existingWorkItem.title,
        summary: existingWorkItem.summary,
        kind: existingWorkItem.kind,
        executionMode: existingWorkItem.executionMode,
        ownerRole: existingWorkItem.ownerRole,
        status: "waiting_review",
        priorityBucket: inferPriorityBucket("waiting_review"),
        activeRunId: existingWorkItem.activeRunId,
        activePrNumber: pullRequest.number,
        lastSummary: existingWorkItem.lastSummary
      });
    }

    const cycleRows = await session.db
      .select()
      .from(prCyclesTable)
      .where(eq(prCyclesTable.projectId, session.project.id));
    const existingCycle = cycleRows.find((candidate) => candidate.prNumber === pullRequest.number);
    const existingCycleStatus = existingCycle
      ? (existingCycle.status as PrCycleRecord["status"])
      : null;
    await upsertPrCycle(session.db, session.project.id, {
      issueNumber,
      prNumber: pullRequest.number,
      status: pullRequest.checksBucket === "pass" ? "cos_review" : existingCycleStatus ?? "opened",
      summary: summarizeText(pullRequest.title),
      automationWindowEndsAt: existingCycle?.automationWindowEndsAt ?? null,
      lastCheckedAt: existingCycle?.lastCheckedAt ?? null,
      lastHandledCommentAt: existingCycle?.lastHandledCommentAt ?? null,
      mergedAt: existingCycle?.mergedAt ?? null
    });
  }

  const cycleRows = await session.db
    .select()
    .from(prCyclesTable)
    .where(eq(prCyclesTable.projectId, session.project.id));
  for (const cycle of cycleRows) {
    if (!activePrNumbers.has(cycle.prNumber) && cycle.status !== "merged") {
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: cycle.mergedAt ? "merged" : "blocked",
        summary: cycle.summary,
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: cycle.lastCheckedAt,
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
    }
  }
}

async function syncProjectInternal(session: ProjectSession): Promise<DirectorOperationResponse> {
  const [issues, pullRequests, comments] = await Promise.all([
    listIssues(session.project.repoSlug),
    listPullRequests(session.project.repoSlug),
    listComments(session.project.repoSlug)
  ]);

  for (const issue of issues) {
    await upsertGitHubIssueMirror(session.db, session.project.id, {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      workflowState: inferWorkflowState(issue.labels, issue.state),
      labels: issue.labels,
      url: issue.url,
      updatedAt: issue.updatedAt,
      syncedAt: nowIso()
    });
  }

  for (const pullRequest of pullRequests) {
    await upsertGitHubPullRequestMirror(session.db, session.project.id, {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      reviewDecision: pullRequest.reviewDecision,
      checksBucket: pullRequest.checksBucket,
      headRefName: pullRequest.headRefName,
      baseRefName: pullRequest.baseRefName,
      url: pullRequest.url,
      linkedIssueNumbers: pullRequest.linkedIssueNumbers,
      updatedAt: pullRequest.updatedAt,
      syncedAt: nowIso()
    });
  }

  for (const comment of comments) {
    await upsertGitHubCommentMirror(session.db, session.project.id, {
      githubId: comment.githubId,
      parentType: comment.parentType,
      parentNumber: comment.parentNumber,
      author: comment.author,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      syncedAt: nowIso()
    });
  }

  await seedWorkItemsFromGitHub(session);
  await syncPrCyclesFromGitHub(session);
  await recordEvent(session.db, session.project.id, "github.synced", {
    issues: issues.length,
    pullRequests: pullRequests.length,
    comments: comments.length
  });

  return {
    ok: true,
    issues: issues.length,
    pullRequests: pullRequests.length,
    comments: comments.length
  };
}

function parseDataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDataArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object")
    : [];
}

async function chooseNextWorkItem(session: ProjectSession): Promise<WorkItemRecord | null> {
  const workItems = (
    await session.db
      .select()
      .from(workItemsTable)
      .where(eq(workItemsTable.projectId, session.project.id))
  )
    .map(mapWorkItemRow)
    .filter((workItem) =>
      ["queued", "ready"].includes(workItem.status) &&
      workItem.activePrNumber === null &&
      workItem.activeRunId === null
    )
    .sort((left, right) =>
      left.priorityBucket === right.priorityBucket
        ? left.issueNumber - right.issueNumber
        : left.priorityBucket - right.priorityBucket
    );

  if (!workItems.length) {
    return null;
  }

  const fallbackWorkItem = assertPresent(
    workItems[0],
    "At least one queued work item should exist before selection."
  );

  if (workItems.length === 1) {
    return fallbackWorkItem;
  }

  const prompt = [
    "You are the Chief of Staff for Director OS.",
    "Choose the next GitHub issue to execute, classify it as lane or worker, and decide whether it is a workstream or task.",
    "Prefer locally ready work first, then choose the highest-leverage remaining bounded slice.",
    "Return the machine-readable selection in `data` using keys `selected_issue_number`, `execution_mode`, `kind`, and `rationale`.",
    "",
    "Candidates:",
    ...workItems.slice(0, 8).map((workItem) =>
      `- #${workItem.issueNumber} (${workItem.status}, ${workItem.kind}, ${workItem.executionMode}): ${workItem.title}\n  Summary: ${workItem.summary}`
    )
  ].join("\n");

  const result = await runCodexAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt
    },
    {
      status: "ok",
      summary: `Selected issue #${fallbackWorkItem.issueNumber} by fallback ordering.`,
      recommended_next_action: "Dispatch the first locally ready or queued issue.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        selected_issue_number: fallbackWorkItem.issueNumber,
        execution_mode: fallbackWorkItem.executionMode,
        kind: fallbackWorkItem.kind,
        rationale: "Fallback ordering selected the first available issue."
      }
    }
  );

  const selection = parseDataNumber(result.data?.selected_issue_number) ?? fallbackWorkItem.issueNumber;
  const chosen = workItems.find((candidate) => candidate.issueNumber === selection) ?? fallbackWorkItem;
  const executionMode = parseDataString(result.data?.execution_mode) as ExecutionMode | null;
  const kind = parseDataString(result.data?.kind) as WorkItemKind | null;
  const rationale = parseDataString(result.data?.rationale) ?? result.summary;

  const nextStatus = executionMode === "lane" ? "planning" : "ready";
  return upsertWorkItem(session.db, session.project.id, {
    issueNumber: chosen.issueNumber,
    parentIssueNumber: chosen.parentIssueNumber,
    title: chosen.title,
    summary: chosen.summary,
    kind: kind ?? chosen.kind,
    executionMode: executionMode ?? chosen.executionMode,
    ownerRole: (executionMode ?? chosen.executionMode) === "lane" ? "lane_owner" : "worker",
    status: nextStatus,
    priorityBucket: inferPriorityBucket(nextStatus),
    activeRunId: chosen.activeRunId,
    activePrNumber: chosen.activePrNumber,
    lastSummary: rationale
  });
}

async function createIssuesFromPlan(
  session: ProjectSession,
  parentIssueNumber: number,
  items: Array<Record<string, unknown>>,
  executionMode: ExecutionMode
): Promise<number[]> {
  const created: number[] = [];

  for (const item of items.slice(0, 5)) {
    const title = parseDataString(item.title);
    const body = parseDataString(item.body);
    if (!title || !body) {
      continue;
    }

    const issue = await createIssue(session.project.repoSlug, {
      title,
      body: `${body}\n\nParent workstream: #${parentIssueNumber}`,
      labels: [labelFor("task"), labelFor("ready"), labelFor(executionMode === "lane" ? "lane" : "worker")]
    });

    created.push(issue.number);
    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: issue.number,
      parentIssueNumber,
      title,
      summary: summarizeText(body),
      kind: "task",
      executionMode,
      ownerRole: executionMode === "lane" ? "lane_owner" : "worker",
      status: "ready",
      priorityBucket: inferPriorityBucket("ready"),
      activeRunId: null,
      activePrNumber: null,
      lastSummary: `Spawned from lane plan for #${parentIssueNumber}.`
    });
  }

  return created;
}

async function maybeExpandNotesIntoIssues(session: ProjectSession): Promise<boolean> {
  const notes = (
    await session.db
      .select()
      .from(directorNotesTable)
      .where(eq(directorNotesTable.projectId, session.project.id))
  )
    .map(mapNoteRow)
    .filter((note) => note.status === "active");

  if (!notes.length) {
    return false;
  }

  const primaryNote = assertPresent(notes[0], "At least one active director note is required.");

  const prompt = [
    "You are the Chief of Staff for Director OS.",
    "The backlog is empty. Turn the director's most recent note into 1 to 3 concrete GitHub issues.",
    "Return them in `data.new_issues` as objects with `title`, `body`, `kind`, and `execution_mode`.",
    "Only create issues that are bounded enough to enter the queue immediately.",
    "",
    "Active notes:",
    ...notes.slice(0, 3).map((note) => `- ${note.content}`)
  ].join("\n");

  const result = await runCodexAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt
    },
    {
      status: "needs_input",
      summary: "No expansion issues were proposed.",
      recommended_next_action: "Ask the director for a more concrete note.",
      artifact_refs: [],
      blocking_questions: []
    }
  );

  const items = parseDataArray(result.data?.new_issues);
  if (!items.length) {
    return false;
  }

  for (const item of items.slice(0, 3)) {
    const title = parseDataString(item.title);
    const body = parseDataString(item.body);
    const kind = (parseDataString(item.kind) as WorkItemKind | null) ?? "task";
    const executionMode = (parseDataString(item.execution_mode) as ExecutionMode | null) ?? (kind === "workstream" ? "lane" : "worker");
    if (!title || !body) {
      continue;
    }

    const created = await createIssue(session.project.repoSlug, {
      title,
      body,
      labels: [labelFor(kind), labelFor("ready"), labelFor(executionMode)]
    });

    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: created.number,
      parentIssueNumber: null,
      title,
      summary: summarizeText(body),
      kind,
      executionMode,
      ownerRole: executionMode === "lane" ? "lane_owner" : "worker",
      status: "ready",
      priorityBucket: inferPriorityBucket("ready"),
      activeRunId: null,
      activePrNumber: null,
      lastSummary: `Generated from director note ${primaryNote.id}.`
    });
  }

  await session.db
    .update(directorNotesTable)
    .set({
      status: "archived",
      updatedAt: nowIso()
    })
    .where(eq(directorNotesTable.id, primaryNote.id));

  await recordEvent(session.db, session.project.id, "director_note.expanded", {
    noteId: primaryNote.id
  });

  return true;
}

async function planLaneWork(session: ProjectSession, workItem: WorkItemRecord): Promise<void> {
  const issueRows = await session.db
    .select()
    .from(githubIssuesTable)
    .where(eq(githubIssuesTable.projectId, session.project.id));
  const issue = issueRows.map(mapGitHubIssueRow).find((candidate) => candidate.number === workItem.issueNumber);
  const liveIssue = assertPresent(issue, `Issue #${workItem.issueNumber} is missing from the local mirror.`);

  const run = await insertRun(session, {
    workItemId: workItem.id,
    issueNumber: workItem.issueNumber,
    prNumber: null,
    role: "lane_owner",
    status: "running",
    phase: "planning",
    summary: `Planning workstream #${workItem.issueNumber}.`,
    recommendedNextAction: null,
    artifacts: [],
    blockingQuestions: [],
    outputJson: null,
    worktreePath: null
  });

  await upsertWorkItem(session.db, session.project.id, {
    issueNumber: workItem.issueNumber,
    parentIssueNumber: workItem.parentIssueNumber,
    title: workItem.title,
    summary: workItem.summary,
    kind: "workstream",
    executionMode: "lane",
    ownerRole: "lane_owner",
    status: "planning",
    priorityBucket: inferPriorityBucket("planning"),
    activeRunId: run.id,
    activePrNumber: workItem.activePrNumber,
    lastSummary: workItem.lastSummary
  });

  const laneResult = await runCodexAgent(
    {
      role: "lane_owner",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt: [
        `You own GitHub issue #${liveIssue.number}: ${liveIssue.title}.`,
        "Plan the slice end to end before any write-enabled execution begins.",
        "If this should split into child issues, return them in `data.child_tasks` as objects with `title` and `body`.",
        "Only raise blocking questions when genuine product judgment is required.",
        "",
        liveIssue.body
      ].join("\n")
    },
    {
      status: "ok",
      summary: `Fallback lane plan for #${liveIssue.number}: continue as a bounded worker issue.`,
      recommended_next_action: "Execute the issue directly as a worker task.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        child_tasks: []
      }
    }
  );

  await updateRun(session, run.id, {
    status: laneResult.status === "failed" ? "failed" : laneResult.status === "needs_input" ? "needs_input" : "succeeded",
    summary: laneResult.summary,
    recommendedNextAction: laneResult.recommended_next_action,
    artifacts: laneResult.artifact_refs,
    blockingQuestions: laneResult.blocking_questions,
    outputJson: laneResult.data ?? null
  });

  if (laneResult.blocking_questions.length > 0) {
    await createDecision(session, {
      workItemId: workItem.id,
      issueNumber: workItem.issueNumber,
      prNumber: null,
      target: "human_director",
      title: `Answer product questions for #${workItem.issueNumber}`,
      summary: laneResult.summary,
      recommendation: laneResult.recommended_next_action,
      rationale: laneResult.blocking_questions.join("\n")
    });

    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: workItem.issueNumber,
      parentIssueNumber: workItem.parentIssueNumber,
      title: workItem.title,
      summary: workItem.summary,
      kind: "workstream",
      executionMode: "lane",
      ownerRole: "lane_owner",
      status: "waiting_decision",
      priorityBucket: inferPriorityBucket("waiting_decision"),
      activeRunId: null,
      activePrNumber: workItem.activePrNumber,
      lastSummary: laneResult.summary
    });
    return;
  }

  const childTasks = parseDataArray(laneResult.data?.child_tasks);
  if (childTasks.length) {
    await createIssuesFromPlan(session, workItem.issueNumber, childTasks, "worker");
    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: workItem.issueNumber,
      parentIssueNumber: workItem.parentIssueNumber,
      title: workItem.title,
      summary: workItem.summary,
      kind: "workstream",
      executionMode: "lane",
      ownerRole: "lane_owner",
      status: "running",
      priorityBucket: inferPriorityBucket("running"),
      activeRunId: null,
      activePrNumber: workItem.activePrNumber,
      lastSummary: laneResult.summary
    });
    await recordEvent(session.db, session.project.id, "lane.plan_spawned", {
      issueNumber: workItem.issueNumber,
      childCount: childTasks.length
    });
    return;
  }

  await upsertWorkItem(session.db, session.project.id, {
    issueNumber: workItem.issueNumber,
    parentIssueNumber: workItem.parentIssueNumber,
    title: workItem.title,
    summary: workItem.summary,
    kind: "task",
    executionMode: "worker",
    ownerRole: "worker",
    status: "ready",
    priorityBucket: inferPriorityBucket("ready"),
    activeRunId: null,
    activePrNumber: workItem.activePrNumber,
    lastSummary: laneResult.summary
  });
}

async function executeWorkerRun(
  session: ProjectSession,
  workItem: WorkItemRecord,
  options: {
    issue: GitHubIssueRecord;
    phase: string;
    promptSuffix?: string;
    existingPrNumber?: number | null;
    existingHeadRefName?: string | null;
  }
): Promise<void> {
  const branchName =
    options.existingHeadRefName ??
    `codex/issue-${workItem.issueNumber}-${slugify(workItem.title).slice(0, 36)}`;
  const worktreePath = path.join(session.project.worktreeRoot, `issue-${workItem.issueNumber}`);

  await ensureWorktree(session.project, workItem.issueNumber, branchName, worktreePath);

  const existingWorktreeRows = await session.db
    .select()
    .from(worktreesTable)
    .where(eq(worktreesTable.path, worktreePath))
    .limit(1);
  const timestamp = nowIso();
  if (existingWorktreeRows[0]) {
    await session.db
      .update(worktreesTable)
      .set({
        issueNumber: workItem.issueNumber,
        branchName,
        status: "active",
        updatedAt: timestamp
      })
      .where(eq(worktreesTable.id, existingWorktreeRows[0].id));
  } else {
    await session.db.insert(worktreesTable).values({
      projectId: session.project.id,
      issueNumber: workItem.issueNumber,
      branchName,
      path: worktreePath,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  const run = await insertRun(session, {
    workItemId: workItem.id,
    issueNumber: workItem.issueNumber,
    prNumber: options.existingPrNumber ?? null,
    role: "worker",
    status: "running",
    phase: options.phase,
    summary: `Executing issue #${workItem.issueNumber}.`,
    recommendedNextAction: null,
    artifacts: [worktreePath],
    blockingQuestions: [],
    outputJson: null,
    worktreePath
  });

  await upsertWorkItem(session.db, session.project.id, {
    issueNumber: workItem.issueNumber,
    parentIssueNumber: workItem.parentIssueNumber,
    title: workItem.title,
    summary: workItem.summary,
    kind: workItem.kind,
    executionMode: "worker",
    ownerRole: "worker",
    status: "running",
    priorityBucket: inferPriorityBucket("running"),
    activeRunId: run.id,
    activePrNumber: workItem.activePrNumber,
    lastSummary: workItem.lastSummary
  });

  const workerResult = await runCodexAgent(
    {
      role: "worker",
      cwd: worktreePath,
      model: session.project.model,
      allowWrite: true,
      prompt: [
        `Implement GitHub issue #${options.issue.number}: ${options.issue.title}.`,
        "Use your built-in planning discipline before editing, then make the bounded code changes needed to satisfy the issue.",
        "If product judgment is required, do not guess; explain the blocking question.",
        "Leave the repository ready for commit.",
        "",
        options.issue.body,
        options.promptSuffix ? `\nFollow-up context:\n${options.promptSuffix}` : ""
      ].join("\n")
    },
    {
      status: "needs_input",
      summary: `Worker completed without a clear implementation outcome for #${options.issue.number}.`,
      recommended_next_action: "Inspect the worktree and decide whether to retry or escalate.",
      artifact_refs: [worktreePath],
      blocking_questions: []
    }
  );

  if (workerResult.blocking_questions.length > 0 || workerResult.status === "needs_input") {
    await updateRun(session, run.id, {
      status: "needs_input",
      summary: workerResult.summary,
      recommendedNextAction: workerResult.recommended_next_action,
      artifacts: workerResult.artifact_refs,
      blockingQuestions: workerResult.blocking_questions,
      outputJson: workerResult.data ?? null
    });

    await createDecision(session, {
      workItemId: workItem.id,
      issueNumber: workItem.issueNumber,
      prNumber: options.existingPrNumber ?? null,
      target: "human_director",
      title: `Clarify issue #${workItem.issueNumber}`,
      summary: workerResult.summary,
      recommendation: workerResult.recommended_next_action,
      rationale: workerResult.blocking_questions.join("\n") || "Worker requested human clarification."
    });

    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: workItem.issueNumber,
      parentIssueNumber: workItem.parentIssueNumber,
      title: workItem.title,
      summary: workItem.summary,
      kind: workItem.kind,
      executionMode: "worker",
      ownerRole: "worker",
      status: "waiting_decision",
      priorityBucket: inferPriorityBucket("waiting_decision"),
      activeRunId: null,
      activePrNumber: options.existingPrNumber ?? workItem.activePrNumber,
      lastSummary: workerResult.summary
    });
    return;
  }

  try {
    await maybeRunPackageScript(worktreePath, "test");
    await maybeRunPackageScript(worktreePath, "build");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(session, run.id, {
      status: "failed",
      summary: `Validation failed for #${workItem.issueNumber}: ${message}`,
      recommendedNextAction: "Inspect the failing command output and retry.",
      artifacts: [worktreePath],
      blockingQuestions: [],
      outputJson: workerResult.data ?? null
    });
    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: workItem.issueNumber,
      parentIssueNumber: workItem.parentIssueNumber,
      title: workItem.title,
      summary: workItem.summary,
      kind: workItem.kind,
      executionMode: "worker",
      ownerRole: "worker",
      status: "blocked",
      priorityBucket: inferPriorityBucket("blocked"),
      activeRunId: null,
      activePrNumber: options.existingPrNumber ?? workItem.activePrNumber,
      lastSummary: message
    });
    return;
  }

  const statusOutput = await runCommand("git", ["status", "--porcelain"], worktreePath);
  if (!statusOutput.trim()) {
    await updateRun(session, run.id, {
      status: "needs_input",
      summary: "Worker completed without producing file changes.",
      recommendedNextAction: "Inspect the repository and decide whether the issue needs a different prompt.",
      artifacts: [worktreePath],
      blockingQuestions: [],
      outputJson: workerResult.data ?? null
    });
    await upsertWorkItem(session.db, session.project.id, {
      issueNumber: workItem.issueNumber,
      parentIssueNumber: workItem.parentIssueNumber,
      title: workItem.title,
      summary: workItem.summary,
      kind: workItem.kind,
      executionMode: "worker",
      ownerRole: "worker",
      status: "blocked",
      priorityBucket: inferPriorityBucket("blocked"),
      activeRunId: null,
      activePrNumber: options.existingPrNumber ?? workItem.activePrNumber,
      lastSummary: workerResult.summary
    });
    return;
  }

  await runCommand("git", ["add", "-A"], worktreePath);
  await runCommand(
    "git",
    ["commit", "-m", `${options.existingPrNumber ? "Refine" : "Implement"} #${workItem.issueNumber}: ${workItem.title}`],
    worktreePath
  );
  await runCommand("git", ["push", "-u", "origin", branchName], worktreePath);

  let prNumber = options.existingPrNumber ?? null;
  let prUrl: string | null = null;

  if (!prNumber) {
    const createdPullRequest = await createPullRequest(worktreePath, {
      baseBranch: session.project.defaultBranch,
      headBranch: branchName,
      title: workItem.title,
      body: [`Fixes #${workItem.issueNumber}`, "", workerResult.summary].join("\n")
    });
    prNumber = createdPullRequest.number;
    prUrl = createdPullRequest.url;
  }

  const livePullRequest = await viewPullRequest(worktreePath, assertPresent(prNumber, "PR number missing after worker run."));
  await upsertGitHubPullRequestMirror(session.db, session.project.id, {
    number: livePullRequest.number,
    title: livePullRequest.title,
    body: livePullRequest.body,
    state: livePullRequest.state.toLowerCase(),
    isDraft: livePullRequest.isDraft,
    reviewDecision: livePullRequest.reviewDecision,
    checksBucket: livePullRequest.checksBucket,
    headRefName: livePullRequest.headRefName,
    baseRefName: livePullRequest.baseRefName,
    url: livePullRequest.url,
    linkedIssueNumbers: livePullRequest.linkedIssueNumbers,
    updatedAt: livePullRequest.updatedAt,
    syncedAt: nowIso()
  });

  await upsertPrCycle(session.db, session.project.id, {
    issueNumber: workItem.issueNumber,
    prNumber: livePullRequest.number,
    status: "opened",
    summary: workerResult.summary,
    automationWindowEndsAt: new Date(Date.now() + AUTOMATION_WAIT_MS).toISOString(),
    lastCheckedAt: nowIso(),
    lastHandledCommentAt: null,
    mergedAt: null
  });

  await updateRun(session, run.id, {
    prNumber: livePullRequest.number,
    status: "succeeded",
    summary: workerResult.summary,
    recommendedNextAction: "Wait through the automated review window, then continue the PR cycle.",
    artifacts: workerResult.artifact_refs.length ? workerResult.artifact_refs : [livePullRequest.url],
    blockingQuestions: workerResult.blocking_questions,
    outputJson: workerResult.data ?? null
  });

  await upsertWorkItem(session.db, session.project.id, {
    issueNumber: workItem.issueNumber,
    parentIssueNumber: workItem.parentIssueNumber,
    title: workItem.title,
    summary: workItem.summary,
    kind: workItem.kind,
    executionMode: "worker",
    ownerRole: "worker",
    status: "waiting_review",
    priorityBucket: inferPriorityBucket("waiting_review"),
    activeRunId: null,
    activePrNumber: livePullRequest.number,
    lastSummary: workerResult.summary
  });

  await recordEvent(session.db, session.project.id, "work_item.pr_opened", {
    issueNumber: workItem.issueNumber,
    prNumber: livePullRequest.number,
    prUrl: prUrl ?? livePullRequest.url
  });
}

function latestUnhandledComment(
  comments: Array<{ author: string; body: string; updatedAt: string }>,
  lastHandledCommentAt: string | null
): { author: string; body: string; updatedAt: string } | null {
  const ordered = [...comments].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const latest = ordered.at(-1) ?? null;
  if (!latest) {
    return null;
  }

  if (!lastHandledCommentAt) {
    return latest;
  }

  return latest.updatedAt > lastHandledCommentAt ? latest : null;
}

async function runCosReviewOnPr(
  session: ProjectSession,
  workItem: WorkItemRecord,
  pr: GitHubPullRequestRecord,
  comments: Array<{ author: string; body: string; updatedAt: string }>
): Promise<"merge" | "changes" | "escalate"> {
  const [diff, checks] = await Promise.all([
    pullRequestDiff(session.project.repoPath, pr.number),
    pullRequestChecks(session.project.repoPath, pr.number)
  ]);

  const result = await runCodexAgent(
    {
      role: "chief_of_staff",
      cwd: session.project.repoPath,
      model: session.project.model,
      allowWrite: false,
      prompt: [
        `You are the Chief of Staff reviewing PR #${pr.number} for issue #${workItem.issueNumber}.`,
        "Decide whether to merge, request changes, or escalate to the human director.",
        "Return the verdict in `data.decision` as `merge`, `changes`, or `escalate`.",
        "If you choose `changes`, provide concise `data.feedback` that a worker can act on.",
        "",
        `Issue: ${workItem.title}`,
        "",
        "Checks:",
        JSON.stringify(checks, null, 2),
        "",
        "Recent comments:",
        comments.length
          ? comments.map((comment) => `- ${comment.author}: ${comment.body}`).join("\n")
          : "No recent PR comments.",
        "",
        "Diff:",
        diff.slice(0, 24_000)
      ].join("\n")
    },
    {
      status: "ok",
      summary: `Fallback CoS review approved merge for PR #${pr.number}.`,
      recommended_next_action: "Merge the pull request.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        decision: "merge"
      }
    }
  );

  const verdict = parseDataString(result.data?.decision);
  const normalized = verdict === "changes" || verdict === "escalate" ? verdict : "merge";

  await insertRun(session, {
    workItemId: workItem.id,
    issueNumber: workItem.issueNumber,
    prNumber: pr.number,
    role: "reviewer",
    status: result.status === "failed" ? "failed" : "succeeded",
    phase: "cos_review",
    summary: result.summary,
    recommendedNextAction: result.recommended_next_action,
    artifacts: result.artifact_refs,
    blockingQuestions: result.blocking_questions,
    outputJson: result.data ?? null,
    worktreePath: null
  });

  if (normalized === "changes") {
    const feedback = parseDataString(result.data?.feedback) ?? result.summary;
    await executeWorkerRun(session, workItem, {
      issue: assertPresent(
        (
          await session.db
            .select()
            .from(githubIssuesTable)
            .where(eq(githubIssuesTable.projectId, session.project.id))
        )
          .map(mapGitHubIssueRow)
          .find((candidate) => candidate.number === workItem.issueNumber),
        `Issue #${workItem.issueNumber} is missing from the local mirror.`
      ),
      phase: "cos_follow_up",
      promptSuffix: feedback,
      existingPrNumber: pr.number,
      existingHeadRefName: pr.headRefName
    });
  }

  if (normalized === "escalate") {
    await createDecision(session, {
      workItemId: workItem.id,
      issueNumber: workItem.issueNumber,
      prNumber: pr.number,
      target: "human_director",
      title: `Resolve merge judgment for PR #${pr.number}`,
      summary: result.summary,
      recommendation: result.recommended_next_action,
      rationale: result.blocking_questions.join("\n") || "Chief of Staff requested a human decision."
    });
  }

  return normalized;
}

async function processPrCycles(session: ProjectSession): Promise<boolean> {
  const cycles = (
    await session.db
      .select()
      .from(prCyclesTable)
      .where(eq(prCyclesTable.projectId, session.project.id))
  )
    .map(mapPrCycleRow)
    .filter((cycle) => cycle.status !== "merged")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  if (!cycles.length) {
    return false;
  }

  const workItems = (
    await session.db
      .select()
      .from(workItemsTable)
      .where(eq(workItemsTable.projectId, session.project.id))
  ).map(mapWorkItemRow);
  const prRows = (
    await session.db
      .select()
      .from(githubPullRequestsTable)
      .where(eq(githubPullRequestsTable.projectId, session.project.id))
  ).map(mapGitHubPullRequestRow);
  const commentRows = await session.db
    .select()
    .from(githubCommentsTable)
    .where(eq(githubCommentsTable.projectId, session.project.id));

  for (const cycle of cycles) {
    const workItem = workItems.find((candidate) => candidate.issueNumber === cycle.issueNumber);
    const pullRequest = prRows.find((candidate) => candidate.number === cycle.prNumber);
    if (!workItem || !pullRequest) {
      continue;
    }

    if (pullRequest.state.toLowerCase() !== "open") {
      const merged = pullRequest.state.toLowerCase() === "merged";
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: merged ? "merged" : "blocked",
        summary: cycle.summary,
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: merged ? nowIso() : cycle.mergedAt
      });
      await upsertWorkItem(session.db, session.project.id, {
        issueNumber: workItem.issueNumber,
        parentIssueNumber: workItem.parentIssueNumber,
        title: workItem.title,
        summary: workItem.summary,
        kind: workItem.kind,
        executionMode: workItem.executionMode,
        ownerRole: workItem.ownerRole,
        status: merged ? "completed" : "blocked",
        priorityBucket: inferPriorityBucket(merged ? "completed" : "blocked"),
        activeRunId: null,
        activePrNumber: merged ? null : cycle.prNumber,
        lastSummary: merged ? "Merged successfully." : "Pull request closed without merge."
      });
      return true;
    }

    if (cycle.automationWindowEndsAt && Date.now() < Date.parse(cycle.automationWindowEndsAt)) {
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "waiting_automation",
        summary: cycle.summary,
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
      continue;
    }

    const comments = commentRows
      .filter((candidate) => candidate.parentType === "pr" && candidate.parentNumber === cycle.prNumber)
      .map((candidate) => ({
        author: candidate.author,
        body: candidate.body,
        updatedAt: candidate.updatedAt
      }));
    const unhandled = latestUnhandledComment(comments, cycle.lastHandledCommentAt);

    if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || unhandled) {
      const issueRows = await session.db
        .select()
        .from(githubIssuesTable)
        .where(eq(githubIssuesTable.projectId, session.project.id));
      const issue = issueRows.map(mapGitHubIssueRow).find((candidate) => candidate.number === workItem.issueNumber);
      if (!issue) {
        continue;
      }

      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "changes_requested",
        summary: unhandled?.body ? summarizeText(unhandled.body) : "Changes requested on the pull request.",
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: unhandled?.updatedAt ?? cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });

      await executeWorkerRun(session, workItem, {
        issue,
        phase: "review_follow_up",
        promptSuffix: unhandled?.body ?? "Review feedback was requested on the pull request.",
        existingPrNumber: pullRequest.number,
        existingHeadRefName: pullRequest.headRefName
      });

      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "revalidating",
        summary: "Worker addressed review feedback and pushed a follow-up commit.",
        automationWindowEndsAt: new Date(Date.now() + AUTOMATION_WAIT_MS).toISOString(),
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: unhandled?.updatedAt ?? cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
      return true;
    }

    if (!pullRequest.checksBucket || pullRequest.checksBucket === "pending") {
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "waiting_automation",
        summary: "Waiting for checks to settle.",
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
      continue;
    }

    if (pullRequest.checksBucket === "fail") {
      await createDecision(session, {
        workItemId: workItem.id,
        issueNumber: workItem.issueNumber,
        prNumber: pullRequest.number,
        target: "human_director",
        title: `Investigate failing checks on PR #${pullRequest.number}`,
        summary: "Automated checks failed and need human judgment or a deeper fix.",
        recommendation: "Inspect the failing GitHub checks and decide whether to retry or narrow scope.",
        rationale: "The current MVP does not yet fetch full CI logs for autonomous remediation."
      });
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "blocked",
        summary: "Checks failed and were escalated.",
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
      return true;
    }

    await upsertPrCycle(session.db, session.project.id, {
      issueNumber: cycle.issueNumber,
      prNumber: cycle.prNumber,
      status: "cos_review",
      summary: "Checks passed. Chief of Staff is reviewing merge readiness.",
      automationWindowEndsAt: cycle.automationWindowEndsAt,
      lastCheckedAt: nowIso(),
      lastHandledCommentAt: cycle.lastHandledCommentAt,
      mergedAt: cycle.mergedAt
    });

    const verdict = await runCosReviewOnPr(session, workItem, pullRequest, comments);
    if (verdict === "merge") {
      await mergePullRequest(session.project.repoPath, pullRequest.number);
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "merged",
        summary: "Chief of Staff merged the pull request.",
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: nowIso()
      });
      await upsertWorkItem(session.db, session.project.id, {
        issueNumber: workItem.issueNumber,
        parentIssueNumber: workItem.parentIssueNumber,
        title: workItem.title,
        summary: workItem.summary,
        kind: workItem.kind,
        executionMode: workItem.executionMode,
        ownerRole: workItem.ownerRole,
        status: "completed",
        priorityBucket: inferPriorityBucket("completed"),
        activeRunId: null,
        activePrNumber: null,
        lastSummary: "Merged by Chief of Staff."
      });
    } else if (verdict === "escalate") {
      await upsertPrCycle(session.db, session.project.id, {
        issueNumber: cycle.issueNumber,
        prNumber: cycle.prNumber,
        status: "blocked",
        summary: "Chief of Staff escalated merge judgment.",
        automationWindowEndsAt: cycle.automationWindowEndsAt,
        lastCheckedAt: nowIso(),
        lastHandledCommentAt: cycle.lastHandledCommentAt,
        mergedAt: cycle.mergedAt
      });
    }
    return true;
  }

  return false;
}

async function processNextQueueItem(session: ProjectSession): Promise<boolean> {
  const next = await chooseNextWorkItem(session);
  if (!next) {
    const expanded = await maybeExpandNotesIntoIssues(session);
    if (expanded) {
      return true;
    }

    const openDecisions = (
      await session.db
        .select()
        .from(decisionsTable)
        .where(eq(decisionsTable.projectId, session.project.id))
    )
      .map(mapDecisionRow)
      .filter((decision) => decision.status === "open" && decision.title === "No queueable work remains");
    if (!openDecisions.length) {
      await createDecision(session, {
        workItemId: null,
        issueNumber: null,
        prNumber: null,
        target: "human_director",
        title: "No queueable work remains",
        summary: "The backlog is empty and the Chief of Staff could not expand any active notes.",
        recommendation: "Add a new director note or create fresh GitHub issues.",
        rationale: "Director OS ran out of safe autonomous work."
      });
    }
    return false;
  }

  if (next.executionMode === "lane") {
    await planLaneWork(session, next);
    return true;
  }

  const issueRows = await session.db
    .select()
    .from(githubIssuesTable)
    .where(eq(githubIssuesTable.projectId, session.project.id));
  const issue = issueRows.map(mapGitHubIssueRow).find((candidate) => candidate.number === next.issueNumber);
  if (!issue) {
    return false;
  }

  await executeWorkerRun(session, next, {
    issue,
    phase: "implementation"
  });
  return true;
}

async function runOrchestratorIteration(): Promise<boolean> {
  return withProject(async (session) => {
    const orchestrator = await ensureOrchestratorRow(session);
    if (orchestrator.status !== "running") {
      return false;
    }

    try {
      await syncProjectInternal(session);
      const handledPrCycle = await processPrCycles(session);
      const handledQueue = handledPrCycle ? true : await processNextQueueItem(session);
      await setOrchestratorState(session, "running", {
        lastLoopAt: nowIso(),
        lastSummary: handledPrCycle
          ? "Processed an active PR cycle."
          : handledQueue
            ? "Processed the next queued work item."
            : "No autonomous work was available this cycle."
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setOrchestratorState(session, "blocked", {
        lastLoopAt: nowIso(),
        lastSummary: message
      });
      await createDecision(session, {
        workItemId: null,
        issueNumber: null,
        prNumber: null,
        target: "human_director",
        title: "Orchestrator blocked",
        summary: message,
        recommendation: "Inspect the latest run and local environment, then restart the orchestrator.",
        rationale: "The background loop hit an unexpected error."
      });
      return false;
    }

    const refreshed = await ensureOrchestratorRow(session);
    return refreshed.status === "running";
  });
}

function scheduleOrchestratorLoop(delayMs = 0): void {
  if (orchestratorTimer) {
    clearTimeout(orchestratorTimer);
  }

  orchestratorTimer = setTimeout(() => {
    orchestratorTimer = null;
    void ensureOrchestratorLoop();
  }, delayMs);
}

async function ensureOrchestratorLoop(): Promise<void> {
  if (orchestratorRunning) {
    return;
  }

  orchestratorRunning = true;
  try {
    const shouldContinue = await runOrchestratorIteration();
    if (shouldContinue) {
      scheduleOrchestratorLoop(LOOP_INTERVAL_MS);
    }
  } finally {
    orchestratorRunning = false;
  }
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);

    if (activeProject) {
      const { draft, check } = await buildRepositoryDraft(
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
        repositoryCheck: check,
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
    const { draft, check } = await buildRepositoryDraft(input, session.paths);

    return evaluateSetupState(session, {
      activeProject,
      repositoryDraft: draft,
      repositoryCheck: check,
      runWorkspace: false
    });
  });
}

export async function runWorkspaceSetupTest(
  repositoryDraft: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);
    const { draft, check } = await buildRepositoryDraft(
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
      repositoryCheck: check,
      runWorkspace: true
    });
  });
}

export async function completeSetup(
  repositoryDraft: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return withRuntime(async (session) => {
    const activeProject = await getActiveProjectFromRuntime(session);
    const { draft, check } = await buildRepositoryDraft(
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
      repositoryCheck: check,
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

    if (!options.skipGhCheck) {
      await ensureGhAuthenticated();
    }

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
    const orchestrator = await ensureOrchestratorRow(session);
    if (orchestrator.status === "running" && !orchestratorTimer && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }

    const [workItemRows, decisionRows, prCycleRows, runRows, noteRows, prRows] = await Promise.all([
      session.db.select().from(workItemsTable).where(eq(workItemsTable.projectId, session.project.id)),
      session.db.select().from(decisionsTable).where(eq(decisionsTable.projectId, session.project.id)),
      session.db.select().from(prCyclesTable).where(eq(prCyclesTable.projectId, session.project.id)),
      session.db.select().from(runsTable).where(eq(runsTable.projectId, session.project.id)),
      session.db.select().from(directorNotesTable).where(eq(directorNotesTable.projectId, session.project.id)),
      session.db.select().from(githubPullRequestsTable).where(eq(githubPullRequestsTable.projectId, session.project.id))
    ]);

    const workItems = workItemRows.map(mapWorkItemRow);
    return {
      project: session.project,
      orchestrator,
      queue: selectQueuedWorkItems(workItems),
      activeWork: selectActiveWorkItems(workItems),
      decisions: decisionRows
        .map(mapDecisionRow)
        .filter((decision) => decision.status === "open")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      prCycles: prCycleRows
        .map(mapPrCycleRow)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10),
      recentRuns: runRows
        .map(mapRunRow)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 12),
      notes: noteRows
        .map(mapNoteRow)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 10),
      openPullRequests: prRows
        .map(mapGitHubPullRequestRow)
        .filter((pullRequest) => pullRequest.state.toLowerCase() === "open")
        .sort((left, right) => left.number - right.number)
    };
  });
}

export async function listDecisions(): Promise<DecisionsResponse> {
  return withProject(async (session) => {
    const rows = await session.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.projectId, session.project.id));
    return {
      decisions: rows
        .map(mapDecisionRow)
        .filter((decision) => decision.status === "open")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
  });
}

export async function submitDirectorNote(content: string): Promise<DirectorNoteRecord> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Director note cannot be empty.");
  }

  return withProject(async (session) => {
    const timestamp = nowIso();
    const result = await session.db.insert(directorNotesTable).values({
      projectId: session.project.id,
      content: trimmed,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await recordEvent(session.db, session.project.id, "director_note.created", {
      content: trimmed
    });
    const row = await session.db
      .select()
      .from(directorNotesTable)
      .where(eq(directorNotesTable.id, Number(result.lastInsertRowid)))
      .limit(1);
    const note = mapNoteRow(assertPresent(row[0], "Director note missing after insert."));
    const orchestrator = await ensureOrchestratorRow(session);
    if (orchestrator.status === "running" && !orchestratorTimer && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }
    return note;
  });
}

export async function resolveDecision(
  decisionId: number,
  resolution: string
): Promise<DecisionRecord> {
  const trimmed = resolution.trim();
  if (!trimmed) {
    throw new Error("Resolution cannot be empty.");
  }

  return withProject(async (session) => {
    const rows = await session.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.id, decisionId))
      .limit(1);
    const row = assertPresent(rows[0], `Decision ${decisionId} was not found.`);

    await session.db
      .update(decisionsTable)
      .set({
        status: "resolved",
        resolution: trimmed,
        updatedAt: nowIso()
      })
      .where(eq(decisionsTable.id, decisionId));

    if (row.workItemId) {
      const workItemRows = await session.db
        .select()
        .from(workItemsTable)
        .where(eq(workItemsTable.id, row.workItemId))
        .limit(1);
      if (workItemRows[0]) {
        const workItem = mapWorkItemRow(workItemRows[0]);
        const resumedStatus: WorkItemStatus = workItem.activePrNumber ? "waiting_review" : "ready";
        await upsertWorkItem(session.db, session.project.id, {
          issueNumber: workItem.issueNumber,
          parentIssueNumber: workItem.parentIssueNumber,
          title: workItem.title,
          summary: workItem.summary,
          kind: workItem.kind,
          executionMode: workItem.executionMode,
          ownerRole: workItem.ownerRole,
          status: resumedStatus,
          priorityBucket: inferPriorityBucket(resumedStatus),
          activeRunId: null,
          activePrNumber: workItem.activePrNumber,
          lastSummary: `Decision resolved: ${trimmed}`
        });
      }
    }

    await recordEvent(session.db, session.project.id, "decision.resolved", {
      decisionId,
      resolution: trimmed
    });

    const updatedRows = await session.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.id, decisionId))
      .limit(1);
    const decision = mapDecisionRow(assertPresent(updatedRows[0], `Decision ${decisionId} vanished after update.`));

    const orchestrator = await ensureOrchestratorRow(session);
    if (orchestrator.status === "running" && !orchestratorTimer && !orchestratorRunning) {
      scheduleOrchestratorLoop(0);
    }

    return decision;
  });
}

export async function startOrchestrator(): Promise<DirectorOperationResponse> {
  const response = await withProject(async (session) => {
    await ensureOrchestratorRow(session);
    await setOrchestratorState(session, "running", {
      pauseReason: null,
      lastSummary: "Chief of Staff is running.",
      lastLoopAt: nowIso()
    });
    await recordEvent(session.db, session.project.id, "orchestrator.started", {});
    return {
      ok: true,
      message: "Chief of Staff loop started."
    };
  });

  scheduleOrchestratorLoop(0);
  return response;
}

export async function pauseOrchestrator(reason?: string): Promise<DirectorOperationResponse> {
  return withProject(async (session) => {
    await ensureOrchestratorRow(session);
    await setOrchestratorState(session, "paused", {
      pauseReason: reason?.trim() || "Paused by the director.",
      lastSummary: "Chief of Staff loop paused."
    });
    if (orchestratorTimer) {
      clearTimeout(orchestratorTimer);
      orchestratorTimer = null;
    }
    await recordEvent(session.db, session.project.id, "orchestrator.paused", {
      reason: reason?.trim() || null
    });
    return {
      ok: true,
      message: "Chief of Staff loop paused."
    };
  });
}
