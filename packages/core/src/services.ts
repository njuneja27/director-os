import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";

import {
  DIRECTOR_LABEL_PREFIX,
  type AgentResultEnvelope,
  type AgentRunRecord,
  type BriefAction,
  type BriefDraft,
  type BriefRecord,
  type DirectorOperationResponse,
  type DirectorTaskAction,
  type DirectorTaskRecord,
  type GitHubIssueRecord,
  type GitHubPullRequestRecord,
  type HomeOverview,
  type InboxResponse,
  type IntakeMessage,
  type IntakeResponse,
  type InitCommandOptions,
  type ProjectRecord,
  type SetupCheck,
  type SetupCheckKind,
  type SetupProblemCode,
  type SetupProbeRepositoryInput,
  type SetupRepositoryDraft,
  type SetupStatusResponse,
  type WorkflowState
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
  briefsTable,
  directorTasksTable,
  epicsTable,
  eventsTable,
  fromJson,
  githubCommentsTable,
  githubIssuesTable,
  githubPullRequestsTable,
  migrateDatabase,
  openDatabase,
  projectsTable,
  worktreesTable,
  agentRunsTable,
  type DirectorDatabase
} from "./db.js";
import {
  addIssueLabels,
  commentOnPr,
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
  removeIssueLabels,
  resolveRepoPath,
  viewPullRequest
} from "./github.js";

const execFileAsync = promisify(execFile);

const WORKFLOW_LABELS: WorkflowState[] = [
  "draft",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done"
];

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

type IssuePlan = {
  title: string;
  body: string;
  acceptance: string[];
  workflowState: WorkflowState;
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

function mapBriefRow(row: typeof briefsTable.$inferSelect): BriefRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status as BriefRecord["status"],
    summary: row.summary,
    draft: fromJson(row.draft as BriefDraft),
    transcript: fromJson(row.transcript as IntakeMessage[]),
    githubEpicNumber: row.githubEpicNumber ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapTaskRow(row: typeof directorTasksTable.$inferSelect): DirectorTaskRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    briefId: row.briefId ?? null,
    kind: row.kind as DirectorTaskRecord["kind"],
    title: row.title,
    description: row.description,
    recommendation: row.recommendation,
    status: row.status as DirectorTaskRecord["status"],
    payload: fromJson(row.payload as Record<string, unknown>),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapIssueRow(row: typeof githubIssuesTable.$inferSelect): GitHubIssueRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    workflowState: row.workflowState as WorkflowState,
    labels: fromJson(row.labels as string[]),
    url: row.url,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt
  };
}

function mapPullRequestRow(
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

function mapAgentRunRow(row: typeof agentRunsTable.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status as AgentRunRecord["status"],
    inputSummary: row.inputSummary,
    outputSummary: row.outputSummary,
    outputJson: row.outputJson ? fromJson(row.outputJson as Record<string, unknown>) : null,
    workingDirectory: row.workingDirectory ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function workflowLabel(state: WorkflowState): string {
  return `${DIRECTOR_LABEL_PREFIX}${state}`;
}

function stripWorkflowLabels(labels: string[]): string[] {
  return labels.filter((label) => !WORKFLOW_LABELS.some((state) => label === workflowLabel(state)));
}

function deriveWorkflowState(labels: string[], state: string): WorkflowState {
  const normalizedState = state.toLowerCase();

  if (normalizedState === "closed" || normalizedState === "merged") {
    return "done";
  }

  for (const candidate of WORKFLOW_LABELS) {
    if (labels.includes(workflowLabel(candidate))) {
      return candidate;
    }
  }

  return "draft";
}

function emptyOverview(): HomeOverview {
  return {
    project: null,
    counts: {
      pendingDirectorTasks: 0,
      activeBriefs: 0,
      readyIssues: 0,
      inReviewIssues: 0,
      openPullRequests: 0
    },
    pendingTasks: [],
    activeIssues: [],
    openPullRequests: [],
    recentRuns: [],
    latestBrief: null
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
      check: makeSetupCheck("repository", "needs_action", "Choose the local repository Director OS should operate on.", {
        code: "repo_missing",
        recommendedAction: "Enter the absolute path to a local git checkout."
      })
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
            recommendedAction: "Set the repo's default branch locally or fetch the remote HEAD, then re-check.",
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
      check: makeSetupCheck("repository", "needs_action", "That folder is not a valid git repository.", {
        code: "repo_not_git",
        recommendedAction: "Choose a local git checkout with an `origin` remote.",
        advancedDetail: message
      })
    };
  }
}

async function createGitHubCheck(): Promise<SetupCheck> {
  const probe = await probeGhCli();

  if (probe.ok) {
    return makeSetupCheck("github", "ready", probe.detail, {
      recommendedAction: "GitHub is ready."
    });
  }

  if (probe.reason === "missing") {
    return makeSetupCheck("github", "needs_action", probe.detail, {
      code: "gh_missing",
      recommendedAction: "Install GitHub CLI and try again.",
      advancedDetail: probe.advancedDetail ?? null
    });
  }

  if (probe.reason === "auth_required") {
    return makeSetupCheck("github", "needs_action", probe.detail, {
      code: "gh_auth_required",
      recommendedAction: "Run `gh auth login`, then re-check.",
      advancedDetail: probe.advancedDetail ?? null
    });
  }

  return makeSetupCheck("github", "blocked", probe.detail, {
    code: "gh_probe_failed",
    recommendedAction: "Review the GitHub CLI output and try again.",
    advancedDetail: probe.advancedDetail ?? null
  });
}

async function createCodexCheck(model = "gpt-5.4"): Promise<SetupCheck> {
  const probe = await probeCodexCli(model);

  if (probe.ok) {
    return makeSetupCheck("codex", "ready", probe.detail, {
      recommendedAction: "Codex is ready."
    });
  }

  if (probe.reason === "missing") {
    return makeSetupCheck("codex", "needs_action", probe.detail, {
      code: "codex_missing",
      recommendedAction: "Install Codex on this machine, then re-check.",
      advancedDetail: probe.advancedDetail ?? null
    });
  }

  if (probe.reason === "auth_required") {
    return makeSetupCheck("codex", "needs_action", probe.detail, {
      code: "codex_sign_in_required",
      recommendedAction: "Sign in to Codex, then re-check.",
      advancedDetail: probe.advancedDetail ?? null
    });
  }

  return makeSetupCheck("codex", "blocked", probe.detail, {
    code: "codex_probe_failed",
    recommendedAction: "Review the Codex output and try the local test again.",
    advancedDetail: probe.advancedDetail ?? null
  });
}

async function createWorkspaceCheck(
  session: RuntimeSession,
  repositoryDraft: SetupRepositoryDraft | null,
  prerequisites: {
    repositoryReady: boolean;
    githubReady: boolean;
    codexReady: boolean;
  },
  runWorkspace: boolean
): Promise<SetupCheck> {
  if (!repositoryDraft) {
    return waitingSetupCheck(
      "workspace",
      "Workspace verification starts after a repository has been selected."
    );
  }

  if (!runWorkspace) {
    return waitingSetupCheck(
      "workspace",
      "Run the local test to verify runtime directories, SQLite, and the coding engine."
    );
  }

  if (!prerequisites.repositoryReady || !prerequisites.githubReady || !prerequisites.codexReady) {
    return makeSetupCheck(
      "workspace",
      "blocked",
      "Workspace verification is waiting on the repository, GitHub CLI, and Codex checks.",
      {
        code: "workspace_probe_failed",
        recommendedAction: "Resolve the blocking checks above, then run the local test again."
      }
    );
  }

  try {
    await ensureRuntimeDirectories(session.paths);
    await fs.mkdir(repositoryDraft.worktreeRoot, { recursive: true });
    await fs.access(repositoryDraft.repoPath);

    const probeFile = path.join(session.paths.tmpDir, `workspace-${Date.now()}.tmp`);
    await fs.writeFile(probeFile, "director-os\n", "utf8");
    await fs.rm(probeFile, { force: true });

    const verificationStore = await openDatabase(session.paths);
    try {
      migrateDatabase(verificationStore.sqlite);
    } finally {
      verificationStore.sqlite.close();
    }

    return makeSetupCheck(
      "workspace",
      "ready",
      "Runtime state, SQLite, repository access, and worktree storage are ready.",
      {
        recommendedAction: "Finish setup and open Director Home."
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errno = error as NodeJS.ErrnoException;

    return makeSetupCheck(
      "workspace",
      "blocked",
      errno.code === "EACCES"
        ? "Director OS could not write to its local runtime directories."
        : "Director OS could not complete the local workspace test.",
      {
        code: errno.code === "EACCES" ? "workspace_unwritable" : "workspace_probe_failed",
        recommendedAction:
          errno.code === "EACCES"
            ? "Update local directory permissions, then run the test again."
            : "Review the advanced details and retry the local test.",
        advancedDetail: message
      }
    );
  }
}

function buildSetupStatusResponse(input: {
  activeProject: ProjectRecord | null;
  repositoryDraft: SetupRepositoryDraft | null;
  repositoryCheck: SetupCheck;
  githubCheck: SetupCheck;
  codexCheck: SetupCheck;
  workspaceCheck: SetupCheck;
}): SetupStatusResponse {
  const checks = [
    input.repositoryCheck,
    input.githubCheck,
    input.codexCheck,
    input.workspaceCheck
  ];

  return {
    activeProject: input.activeProject,
    repositoryDraft: input.repositoryDraft,
    checks,
    canComplete: checks.every((check) => check.status === "ready"),
    completed:
      input.activeProject !== null &&
      input.repositoryCheck.status === "ready" &&
      input.githubCheck.status === "ready" &&
      input.codexCheck.status === "ready" &&
      input.workspaceCheck.status === "ready"
  };
}

async function evaluateSetupState(
  session: RuntimeSession,
  options: {
    repositoryDraft: SetupRepositoryDraft | null;
    activeProject: ProjectRecord | null;
    repositoryCheck?: SetupCheck;
    runWorkspace?: boolean;
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
      : waitingSetupCheck(
          "repository",
          "Choose the local repository Director OS should operate on."
        ));
  const githubCheck = await createGitHubCheck();
  const codexCheck = await createCodexCheck(options.repositoryDraft?.model ?? "gpt-5.4");
  const workspaceCheck = await createWorkspaceCheck(
    session,
    options.repositoryDraft,
    {
      repositoryReady: repositoryCheck.status === "ready",
      githubReady: githubCheck.status === "ready",
      codexReady: codexCheck.status === "ready"
    },
    options.runWorkspace ?? false
  );

  return buildSetupStatusResponse({
    activeProject: options.activeProject,
    repositoryDraft: options.repositoryDraft,
    repositoryCheck,
    githubCheck,
    codexCheck,
    workspaceCheck
  });
}

async function persistProjectRegistration(
  session: RuntimeSession,
  repositoryDraft: SetupRepositoryDraft
): Promise<ProjectRecord> {
  const projectConfig = draftToStoredProjectConfig(repositoryDraft);
  const slug = projectConfig.slug;
  const timestamp = nowIso();

  await fs.mkdir(projectConfig.worktreeRoot, { recursive: true });

  let nextConfig = upsertProjectConfig(session.config, {
    ...projectConfig,
    updatedAt: timestamp
  });
  nextConfig = {
    ...nextConfig,
    activeProjectSlug: slug
  };
  await saveConfig(nextConfig, session.paths);

  const existingRows = await session.db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.slug, slug))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    await session.db
      .update(projectsTable)
      .set({
        name: projectConfig.name,
        repoPath: projectConfig.repoPath,
        repoSlug: projectConfig.repoSlug,
        defaultBranch: projectConfig.defaultBranch,
        worktreeRoot: projectConfig.worktreeRoot,
        agentRunner: projectConfig.agentRunner,
        model: projectConfig.model,
        updatedAt: timestamp
      })
      .where(eq(projectsTable.id, existing.id));
  } else {
    await session.db.insert(projectsTable).values({
      name: projectConfig.name,
      slug,
      repoPath: projectConfig.repoPath,
      repoSlug: projectConfig.repoSlug,
      defaultBranch: projectConfig.defaultBranch,
      worktreeRoot: projectConfig.worktreeRoot,
      agentRunner: projectConfig.agentRunner,
      model: projectConfig.model,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  const storedRows = await session.db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.slug, slug))
    .limit(1);
  const storedProject = mapProjectRow(
    assertPresent(storedRows[0], "Failed to persist the initialized project.")
  );

  await recordEvent(session.db, storedProject.id, "project.initialized", {
    slug,
    repoSlug: projectConfig.repoSlug
  });

  return storedProject;
}

async function getLatestBrief(
  db: DirectorDatabase,
  projectId: number
): Promise<BriefRecord | null> {
  const rows = await db
    .select()
    .from(briefsTable)
    .where(eq(briefsTable.projectId, projectId))
    .orderBy(desc(briefsTable.updatedAt))
    .limit(1);

  return rows[0] ? mapBriefRow(rows[0]) : null;
}

async function getBriefById(
  db: DirectorDatabase,
  projectId: number,
  briefId: number
): Promise<BriefRecord | null> {
  const rows = await db
    .select()
    .from(briefsTable)
    .where(and(eq(briefsTable.projectId, projectId), eq(briefsTable.id, briefId)))
    .limit(1);

  return rows[0] ? mapBriefRow(rows[0]) : null;
}

async function getIssueByNumber(
  db: DirectorDatabase,
  projectId: number,
  issueNumber: number
): Promise<GitHubIssueRecord | null> {
  const rows = await db
    .select()
    .from(githubIssuesTable)
    .where(and(eq(githubIssuesTable.projectId, projectId), eq(githubIssuesTable.number, issueNumber)))
    .limit(1);

  return rows[0] ? mapIssueRow(rows[0]) : null;
}

async function getPullRequestByNumber(
  db: DirectorDatabase,
  projectId: number,
  prNumber: number
): Promise<GitHubPullRequestRecord | null> {
  const rows = await db
    .select()
    .from(githubPullRequestsTable)
    .where(
      and(
        eq(githubPullRequestsTable.projectId, projectId),
        eq(githubPullRequestsTable.number, prNumber)
      )
    )
    .limit(1);

  return rows[0] ? mapPullRequestRow(rows[0]) : null;
}

async function insertAgentRun(
  db: DirectorDatabase,
  input: Omit<AgentRunRecord, "id">
): Promise<AgentRunRecord> {
  const inserted = await db
    .insert(agentRunsTable)
    .values({
      projectId: input.projectId,
      role: input.role,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status,
      inputSummary: input.inputSummary,
      outputSummary: input.outputSummary,
      outputJson: input.outputJson ? asJson(input.outputJson) : null,
      workingDirectory: input.workingDirectory,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    })
    .returning();

  return mapAgentRunRow(assertPresent(inserted[0], "Failed to insert agent run."));
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

async function upsertIssueMirror(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<GitHubIssueRecord, "id" | "projectId">
): Promise<GitHubIssueRecord> {
  const existing = await getIssueByNumber(db, projectId, input.number);
  const values = {
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
  };

  if (existing) {
    await db
      .update(githubIssuesTable)
      .set(values)
      .where(eq(githubIssuesTable.id, existing.id));
  } else {
    await db.insert(githubIssuesTable).values(values);
  }

  return assertPresent(
    await getIssueByNumber(db, projectId, input.number),
    `Issue #${input.number} was not persisted.`
  );
}

async function upsertPullRequestMirror(
  db: DirectorDatabase,
  projectId: number,
  input: Omit<GitHubPullRequestRecord, "id" | "projectId">
): Promise<GitHubPullRequestRecord> {
  const existing = await getPullRequestByNumber(db, projectId, input.number);
  const values = {
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
  };

  if (existing) {
    await db
      .update(githubPullRequestsTable)
      .set(values)
      .where(eq(githubPullRequestsTable.id, existing.id));
  } else {
    await db.insert(githubPullRequestsTable).values(values);
  }

  return assertPresent(
    await getPullRequestByNumber(db, projectId, input.number),
    `Pull request #${input.number} was not persisted.`
  );
}

async function upsertCommentMirror(
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
  const existing = await db
    .select()
    .from(githubCommentsTable)
    .where(eq(githubCommentsTable.githubId, input.githubId))
    .limit(1);

  const values = {
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
  };

  if (existing[0]) {
    await db
      .update(githubCommentsTable)
      .set(values)
      .where(eq(githubCommentsTable.id, existing[0].id));
  } else {
    await db.insert(githubCommentsTable).values(values);
  }
}

async function ensureDirectorTask(
  db: DirectorDatabase,
  input: Omit<DirectorTaskRecord, "id" | "createdAt" | "updatedAt">
): Promise<DirectorTaskRecord> {
  const rows = await db
    .select()
    .from(directorTasksTable)
    .where(
      and(
        eq(directorTasksTable.projectId, input.projectId),
        eq(directorTasksTable.kind, input.kind),
        eq(directorTasksTable.status, "ready_for_director")
      )
    )
    .orderBy(desc(directorTasksTable.updatedAt))
    .limit(1);

  const existing = rows.find((row) => row.briefId === input.briefId);

  if (existing) {
    return mapTaskRow(existing);
  }

  const timestamp = nowIso();
  const inserted = await db
    .insert(directorTasksTable)
    .values({
      projectId: input.projectId,
      briefId: input.briefId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      recommendation: input.recommendation,
      status: input.status,
      payload: asJson(input.payload),
      createdAt: timestamp,
      updatedAt: timestamp
    })
    .returning();

  return mapTaskRow(assertPresent(inserted[0], "Failed to create director task."));
}

async function resolveDirectorTasksForBrief(
  db: DirectorDatabase,
  projectId: number,
  briefId: number
): Promise<void> {
  await db
    .update(directorTasksTable)
    .set({
      status: "resolved",
      updatedAt: nowIso()
    })
    .where(
      and(
        eq(directorTasksTable.projectId, projectId),
        eq(directorTasksTable.briefId, briefId)
      )
    );
}

async function resolveDirectorTasksForPr(
  db: DirectorDatabase,
  projectId: number,
  prNumber: number
): Promise<void> {
  const rows = await db
    .select()
    .from(directorTasksTable)
    .where(and(eq(directorTasksTable.projectId, projectId), eq(directorTasksTable.kind, "approve_merge")));

  const matching = rows.filter((row) => {
    const payload = fromJson(row.payload as Record<string, unknown>);
    return Number(payload.prNumber) === prNumber;
  });

  for (const row of matching) {
    await db
      .update(directorTasksTable)
      .set({
        status: "resolved",
        updatedAt: nowIso()
      })
      .where(eq(directorTasksTable.id, row.id));
  }
}

function titleFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8);

  if (!words.length) {
    return "New Product Direction";
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function synthesizeBriefDraft(transcript: IntakeMessage[]): BriefDraft {
  const latestDirectorMessage = [...transcript]
    .reverse()
    .find((entry) => entry.role === "director");
  const seed = latestDirectorMessage?.content ?? "Define the next product improvement.";
  const shortSeed = seed.length > 160 ? `${seed.slice(0, 157)}...` : seed;

  return {
    title: titleFromPrompt(seed),
    problem: shortSeed,
    targetUser: "The primary user affected by this product goal.",
    desiredOutcome: "A clearer, higher-confidence experience tied to this product direction.",
    constraints: [
      "Keep scope inside an MVP-sized slice.",
      "Preserve existing functionality unless the brief says otherwise."
    ],
    nonGoals: [
      "No broad redesign outside the target flow.",
      "No unrelated platform refactors."
    ],
    successMetrics: [
      "The director can validate the improved flow directly.",
      "The shipped change moves one user-facing outcome in the intended direction."
    ]
  };
}

function parseBriefDraftCandidate(
  value: unknown,
  fallback: BriefDraft
): BriefDraft {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Record<string, unknown>;

  return {
    title: typeof candidate.title === "string" ? candidate.title : fallback.title,
    problem: typeof candidate.problem === "string" ? candidate.problem : fallback.problem,
    targetUser:
      typeof candidate.targetUser === "string" ? candidate.targetUser : fallback.targetUser,
    desiredOutcome:
      typeof candidate.desiredOutcome === "string"
        ? candidate.desiredOutcome
        : fallback.desiredOutcome,
    constraints: Array.isArray(candidate.constraints)
      ? candidate.constraints.filter((item): item is string => typeof item === "string")
      : fallback.constraints,
    nonGoals: Array.isArray(candidate.nonGoals)
      ? candidate.nonGoals.filter((item): item is string => typeof item === "string")
      : fallback.nonGoals,
    successMetrics: Array.isArray(candidate.successMetrics)
      ? candidate.successMetrics.filter((item): item is string => typeof item === "string")
      : fallback.successMetrics
  };
}

function summarizeBrief(brief: BriefDraft): string {
  return `${brief.problem} Target user: ${brief.targetUser}. Desired outcome: ${brief.desiredOutcome}.`;
}

function fallbackIssuePlans(brief: BriefRecord): IssuePlan[] {
  const titleStem = brief.draft.title;

  return [
    {
      title: `Define success checks for ${titleStem}`,
      body: `Translate the approved brief into explicit product acceptance checks and rollout guardrails.`,
      acceptance: [
        "Success criteria are written in the issue body.",
        "Out-of-scope boundaries are captured.",
        "A rollback note exists."
      ],
      workflowState: "ready"
    },
    {
      title: `Implement the primary user-facing change for ${titleStem}`,
      body: `Ship the core UI or workflow update that directly addresses the brief.`,
      acceptance: [
        "The main flow matches the approved brief.",
        "User-facing copy is coherent and task-oriented.",
        "The change is testable by the director."
      ],
      workflowState: "draft"
    },
    {
      title: `Add supporting logic and error handling for ${titleStem}`,
      body: `Cover the backend, state, validation, or integration work needed to make the primary change reliable.`,
      acceptance: [
        "Edge cases are handled.",
        "Relevant data or state changes are wired end to end.",
        "Errors fail in a user-safe way."
      ],
      workflowState: "draft"
    },
    {
      title: `Validate and test ${titleStem}`,
      body: `Add tests and a validation pass for the new behavior.`,
      acceptance: [
        "Automated tests cover the main path where practical.",
        "Manual validation notes are captured.",
        "Known risks are documented."
      ],
      workflowState: "draft"
    }
  ];
}

function parseIssuePlans(value: unknown, brief: BriefRecord): IssuePlan[] {
  if (!Array.isArray(value)) {
    return fallbackIssuePlans(brief);
  }

  const parsed = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const workflowState = WORKFLOW_LABELS.includes(candidate.workflowState as WorkflowState)
        ? (candidate.workflowState as WorkflowState)
        : "draft";

      return {
        title:
          typeof candidate.title === "string"
            ? candidate.title
            : `Task for ${brief.draft.title}`,
        body:
          typeof candidate.body === "string"
            ? candidate.body
            : "Implement the next approved piece of the brief.",
        acceptance: Array.isArray(candidate.acceptance)
          ? candidate.acceptance.filter((entry): entry is string => typeof entry === "string")
          : [],
        workflowState
      } satisfies IssuePlan;
    })
    .filter((item): item is IssuePlan => item !== null);

  return parsed.length ? parsed : fallbackIssuePlans(brief);
}

function buildEpicBody(brief: BriefRecord): string {
  return [
    `# ${brief.draft.title}`,
    "",
    "## Summary",
    brief.summary,
    "",
    "## Problem",
    brief.draft.problem,
    "",
    "## Target User",
    brief.draft.targetUser,
    "",
    "## Desired Outcome",
    brief.draft.desiredOutcome,
    "",
    "## Constraints",
    ...brief.draft.constraints.map((item) => `- ${item}`),
    "",
    "## Non-goals",
    ...brief.draft.nonGoals.map((item) => `- ${item}`),
    "",
    "## Success Metrics",
    ...brief.draft.successMetrics.map((item) => `- ${item}`)
  ].join("\n");
}

function buildIssueBody(brief: BriefRecord, plan: IssuePlan): string {
  return [
    `# ${plan.title}`,
    "",
    plan.body,
    "",
    "## Context",
    brief.summary,
    "",
    "## Acceptance Checks",
    ...plan.acceptance.map((item) => `- ${item}`),
    "",
    "## Out Of Scope",
    ...brief.draft.nonGoals.map((item) => `- ${item}`),
    "",
    "## Rollback Note",
    "Revert the change and return the affected workflow to its prior behavior."
  ].join("\n");
}

async function updateIssueWorkflow(
  session: ProjectSession,
  issue: GitHubIssueRecord,
  nextState: WorkflowState
): Promise<GitHubIssueRecord> {
  const baseLabels = stripWorkflowLabels(issue.labels);
  const nextLabels = [...baseLabels, workflowLabel(nextState)];
  const workflowLabelsToRemove = issue.labels.filter((label) =>
    WORKFLOW_LABELS.some((state) => label === workflowLabel(state))
  );

  await removeIssueLabels(session.project.repoSlug, issue.number, workflowLabelsToRemove);
  await addIssueLabels(session.project.repoSlug, issue.number, [workflowLabel(nextState)]);

  return upsertIssueMirror(session.db, session.project.id, {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    workflowState: nextState,
    labels: nextLabels,
    url: issue.url,
    updatedAt: nowIso(),
    syncedAt: nowIso()
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

    const projectName =
      options.projectName ?? discoveredDraft?.projectName ?? detected?.name ?? path.basename(repoPath);
    const finalDraft: SetupRepositoryDraft = {
      repoPath,
      projectName,
      repoSlug: options.repoSlug ?? discoveredDraft?.repoSlug ?? detected?.repoSlug ?? "",
      defaultBranch:
        options.defaultBranch ?? discoveredDraft?.defaultBranch ?? detected?.defaultBranch ?? "",
      worktreeRoot: path.resolve(
        options.worktreeRoot ?? discoveredDraft?.worktreeRoot ?? path.join(paths.worktreesDir, slugify(projectName))
      ),
      agentRunner: options.agentRunner ?? discoveredDraft?.agentRunner ?? "codex",
      model: options.model ?? discoveredDraft?.model ?? "gpt-5.4"
    };

    if (!finalDraft.repoSlug || !finalDraft.defaultBranch) {
      throw new Error(
        "Could not determine the GitHub repo slug and default branch. Pass them explicitly."
      );
    }

    if (!options.skipGhCheck) {
      const readiness = await evaluateSetupState(session, {
        activeProject: await getActiveProjectFromRuntime(session),
        repositoryDraft: finalDraft,
        runWorkspace: true
      });
      const blocking = readiness.checks.filter((check) => check.status !== "ready");

      if (blocking.length) {
        throw new Error(blocking.map((check) => `${check.title}: ${check.detail}`).join(" "));
      }
    }

    const storedProject = await persistProjectRegistration(session, finalDraft);

    return {
      ok: true,
      paths: session.paths,
      project: storedProject
    };
  });
}

export async function getHomeOverview(): Promise<HomeOverview> {
  return withRuntime(async (session) => {
    const slug = session.config.activeProjectSlug;

    if (!slug) {
      return emptyOverview();
    }

    const rows = await session.db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.slug, slug))
      .limit(1);
    const projectRow = rows[0];

    if (!projectRow) {
      return emptyOverview();
    }

    const project = mapProjectRow(projectRow);
    const [briefRows, taskRows, issueRows, prRows, runRows] = await Promise.all([
      session.db
        .select()
        .from(briefsTable)
        .where(eq(briefsTable.projectId, project.id))
        .orderBy(desc(briefsTable.updatedAt)),
      session.db
        .select()
        .from(directorTasksTable)
        .where(eq(directorTasksTable.projectId, project.id))
        .orderBy(desc(directorTasksTable.updatedAt)),
      session.db
        .select()
        .from(githubIssuesTable)
        .where(eq(githubIssuesTable.projectId, project.id))
        .orderBy(desc(githubIssuesTable.updatedAt)),
      session.db
        .select()
        .from(githubPullRequestsTable)
        .where(eq(githubPullRequestsTable.projectId, project.id))
        .orderBy(desc(githubPullRequestsTable.updatedAt)),
      session.db
        .select()
        .from(agentRunsTable)
        .where(eq(agentRunsTable.projectId, project.id))
        .orderBy(desc(agentRunsTable.updatedAt))
    ]);

    const briefs = briefRows.map(mapBriefRow);
    const tasks = taskRows.map(mapTaskRow);
    const issues = issueRows.map(mapIssueRow);
    const pullRequests = prRows.map(mapPullRequestRow);
    const recentRuns = runRows.map(mapAgentRunRow);

    return {
      project,
      counts: {
        pendingDirectorTasks: tasks.filter((task) => task.status !== "resolved").length,
        activeBriefs: briefs.filter((brief) => brief.status !== "rejected" && brief.status !== "superseded").length,
        readyIssues: issues.filter((issue) => issue.workflowState === "ready").length,
        inReviewIssues: issues.filter((issue) => issue.workflowState === "in_review").length,
        openPullRequests: pullRequests.filter((pr) => pr.state === "open").length
      },
      pendingTasks: tasks.filter((task) => task.status !== "resolved").slice(0, 6),
      activeIssues: issues.filter((issue) => issue.state === "open").slice(0, 8),
      openPullRequests: pullRequests.filter((pr) => pr.state === "open").slice(0, 6),
      recentRuns: recentRuns.slice(0, 6),
      latestBrief: briefs[0] ?? null
    };
  });
}

export async function getInbox(): Promise<InboxResponse> {
  return withRuntime(async (session) => {
    const slug = session.config.activeProjectSlug;

    if (!slug) {
      return {
        tasks: []
      };
    }

    const projectRows = await session.db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.slug, slug))
      .limit(1);
    const projectRow = projectRows[0];

    if (!projectRow) {
      return {
        tasks: []
      };
    }

    const tasks = await session.db
      .select()
      .from(directorTasksTable)
      .where(eq(directorTasksTable.projectId, projectRow.id))
      .orderBy(desc(directorTasksTable.updatedAt));

    return {
      tasks: tasks.map(mapTaskRow).filter((task) => task.status !== "resolved")
    };
  });
}

export async function getIntakeState(): Promise<IntakeResponse> {
  return withRuntime(async (session) => {
    const slug = session.config.activeProjectSlug;

    if (!slug) {
      return {
        project: null,
        brief: null
      };
    }

    const projectRows = await session.db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.slug, slug))
      .limit(1);
    const projectRow = projectRows[0];

    if (!projectRow) {
      return {
        project: null,
        brief: null
      };
    }

    return {
      project: mapProjectRow(projectRow),
      brief: await getLatestBrief(session.db, projectRow.id)
    };
  });
}

export async function syncProject() {
  return withProject(async (session) => {
    const syncedAt = nowIso();
    const [issues, pullRequests, comments] = await Promise.all([
      listIssues(session.project.repoSlug),
      listPullRequests(session.project.repoSlug),
      listComments(session.project.repoSlug)
    ]);

    for (const issue of issues) {
      await upsertIssueMirror(session.db, session.project.id, {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state.toLowerCase(),
        workflowState: deriveWorkflowState(issue.labels, issue.state),
        labels: issue.labels,
        url: issue.url,
        updatedAt: issue.updatedAt,
        syncedAt
      });
    }

    for (const pullRequest of pullRequests) {
      await upsertPullRequestMirror(session.db, session.project.id, {
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
        syncedAt
      });
    }

    for (const comment of comments) {
      await upsertCommentMirror(session.db, session.project.id, {
        ...comment,
        syncedAt
      });
    }

    await recordEvent(session.db, session.project.id, "github.synced", {
      issues: issues.length,
      pullRequests: pullRequests.length,
      comments: comments.length
    });

    return {
      ok: true,
      syncedAt,
      counts: {
        issues: issues.length,
        pullRequests: pullRequests.length,
        comments: comments.length
      }
    };
  });
}

export async function submitIntakeMessage(content: string): Promise<BriefRecord> {
  return withProject(async (session) => {
    const latestBrief = await getLatestBrief(session.db, session.project.id);
    const reusable =
      latestBrief &&
      latestBrief.status !== "approved" &&
      latestBrief.status !== "rejected" &&
      latestBrief.status !== "superseded"
        ? latestBrief
        : null;
    const timestamp = nowIso();
    const baseTranscript = reusable?.transcript ?? [];
    const transcript: IntakeMessage[] = [
      ...baseTranscript,
      {
        role: "director",
        content,
        createdAt: timestamp
      }
    ];

    const fallbackDraft = synthesizeBriefDraft(transcript);
    const chiefOfStaffFallback: AgentResultEnvelope = {
      status: "ok",
      summary: summarizeBrief(fallbackDraft),
      recommended_next_action: "Approve, revise, or reject the draft brief.",
      artifact_refs: [],
      blocking_questions: [],
      data: {
        brief: fallbackDraft
      }
    };

    const envelope = await runCodexAgent(
      {
        role: "chief_of_staff",
        cwd: session.project.repoPath,
        model: session.project.model,
        prompt: [
          "You are the chief of staff for Director OS.",
          "Convert the intake conversation into a concise product brief.",
          "Return JSON with a `data.brief` object containing title, problem, targetUser, desiredOutcome, constraints, nonGoals, and successMetrics.",
          "Also provide a short summary and the next recommended action.",
          "",
          transcript
            .map((entry) => `${entry.role === "director" ? "Director" : "Chief of staff"}: ${entry.content}`)
            .join("\n")
        ].join("\n")
      },
      chiefOfStaffFallback
    );

    const draft = parseBriefDraftCandidate(envelope.data?.brief, fallbackDraft);
    const summary = envelope.summary || summarizeBrief(draft);
    const nextTranscript: IntakeMessage[] = [
      ...transcript,
      {
        role: "chief_of_staff",
        content: summary,
        createdAt: nowIso()
      }
    ];

    let brief: BriefRecord;

    if (reusable) {
      await session.db
        .update(briefsTable)
        .set({
          title: draft.title,
          status: "awaiting_approval",
          summary,
          draft: asJson(draft),
          transcript: asJson(nextTranscript),
          updatedAt: nowIso()
        })
        .where(eq(briefsTable.id, reusable.id));

      brief = assertPresent(
        await getBriefById(session.db, session.project.id, reusable.id),
        `Brief ${reusable.id} disappeared after update.`
      );
    } else {
      const inserted = await session.db
        .insert(briefsTable)
        .values({
          projectId: session.project.id,
          title: draft.title,
          status: "awaiting_approval",
          summary,
          draft: asJson(draft),
          transcript: asJson(nextTranscript),
          githubEpicNumber: null,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        .returning();

      brief = mapBriefRow(assertPresent(inserted[0], "Failed to create a brief."));
    }

    await ensureDirectorTask(session.db, {
      projectId: session.project.id,
      briefId: brief.id,
      kind: "approve_brief",
      title: `Approve brief: ${brief.draft.title}`,
      description: summary,
      recommendation: envelope.recommended_next_action,
      status: "ready_for_director",
      payload: {}
    });

    await insertAgentRun(session.db, {
      projectId: session.project.id,
      role: "chief_of_staff",
      targetType: "brief",
      targetId: String(brief.id),
      status: envelope.status === "failed" ? "failed" : envelope.status === "needs_input" ? "needs_input" : "succeeded",
      inputSummary: content,
      outputSummary: summary,
      outputJson: envelope.data ?? null,
      workingDirectory: session.project.repoPath,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    await recordEvent(session.db, session.project.id, "brief.intake_updated", {
      briefId: brief.id
    });

    return brief;
  });
}

export async function actOnBrief(
  briefId: number,
  action: BriefAction
): Promise<BriefRecord> {
  return withProject(async (session) => {
    const brief = await getBriefById(session.db, session.project.id, briefId);

    if (!brief) {
      throw new Error(`Brief ${briefId} was not found.`);
    }

    if (action === "revise") {
      await session.db
        .update(briefsTable)
        .set({
          status: "draft",
          updatedAt: nowIso()
        })
        .where(eq(briefsTable.id, brief.id));

      await resolveDirectorTasksForBrief(session.db, session.project.id, brief.id);

      return assertPresent(
        await getBriefById(session.db, session.project.id, brief.id),
        `Brief ${brief.id} disappeared after revision.`
      );
    }

    if (action === "reject") {
      await session.db
        .update(briefsTable)
        .set({
          status: "rejected",
          updatedAt: nowIso()
        })
        .where(eq(briefsTable.id, brief.id));

      await resolveDirectorTasksForBrief(session.db, session.project.id, brief.id);

      return assertPresent(
        await getBriefById(session.db, session.project.id, brief.id),
        `Brief ${brief.id} disappeared after rejection.`
      );
    }

    const fallbackPlans = fallbackIssuePlans(brief);
    const planEnvelope = await runCodexAgent(
      {
        role: "spec",
        cwd: session.project.repoPath,
        model: session.project.model,
        prompt: [
          "You are the decomposition agent for Director OS.",
          "Break the approved brief into 3 to 5 implementation issues.",
          "Return them under `data.issues` as objects with title, body, acceptance, and workflowState.",
          "",
          buildEpicBody(brief)
        ].join("\n")
      },
      {
        status: "ok",
        summary: `Created ${fallbackPlans.length} MVP issue slices.`,
        recommended_next_action: "Create the epic and child issues in GitHub.",
        artifact_refs: [],
        blocking_questions: [],
        data: {
          issues: fallbackPlans
        }
      }
    );

    const issuePlans = parseIssuePlans(planEnvelope.data?.issues, brief);
    const epicBody = buildEpicBody(brief);
    const epicRemote = await createIssue(session.project.repoSlug, {
      title: `Epic: ${brief.draft.title}`,
      body: epicBody,
      labels: [`${DIRECTOR_LABEL_PREFIX}epic`, workflowLabel("draft")]
    });

    const syncedAt = nowIso();

    await upsertIssueMirror(session.db, session.project.id, {
      number: epicRemote.number,
      title: `Epic: ${brief.draft.title}`,
      body: epicBody,
      state: "open",
      workflowState: "draft",
      labels: [`${DIRECTOR_LABEL_PREFIX}epic`, workflowLabel("draft")],
      url: epicRemote.url,
      updatedAt: syncedAt,
      syncedAt
    });

    const childNumbers: number[] = [];

    for (const plan of issuePlans) {
      const body = buildIssueBody(brief, plan);
      const labels = [`${DIRECTOR_LABEL_PREFIX}task`, workflowLabel(plan.workflowState)];
      const remoteIssue = await createIssue(session.project.repoSlug, {
        title: plan.title,
        body,
        labels
      });

      childNumbers.push(remoteIssue.number);
      await upsertIssueMirror(session.db, session.project.id, {
        number: remoteIssue.number,
        title: plan.title,
        body,
        state: "open",
        workflowState: plan.workflowState,
        labels,
        url: remoteIssue.url,
        updatedAt: syncedAt,
        syncedAt
      });
    }

    await session.db
      .update(briefsTable)
      .set({
        title: brief.draft.title,
        status: "approved",
        githubEpicNumber: epicRemote.number,
        updatedAt: nowIso()
      })
      .where(eq(briefsTable.id, brief.id));

    await session.db.insert(epicsTable).values({
      projectId: session.project.id,
      briefId: brief.id,
      title: brief.draft.title,
      summary: brief.summary,
      status: "active",
      githubIssueNumber: epicRemote.number,
      childIssueNumbers: asJson(childNumbers),
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    await resolveDirectorTasksForBrief(session.db, session.project.id, brief.id);

    await insertAgentRun(session.db, {
      projectId: session.project.id,
      role: "spec",
      targetType: "brief",
      targetId: String(brief.id),
      status: planEnvelope.status === "failed" ? "failed" : "succeeded",
      inputSummary: brief.summary,
      outputSummary: planEnvelope.summary,
      outputJson: planEnvelope.data ?? null,
      workingDirectory: session.project.repoPath,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    await recordEvent(session.db, session.project.id, "brief.approved", {
      briefId: brief.id,
      epicIssueNumber: epicRemote.number,
      childIssueNumbers: childNumbers
    });

    return assertPresent(
      await getBriefById(session.db, session.project.id, brief.id),
      `Brief ${brief.id} disappeared after approval.`
    );
  });
}

export async function actOnTask(
  taskId: number,
  _action: DirectorTaskAction
): Promise<DirectorTaskRecord> {
  return withProject(async (session) => {
    const rows = await session.db
      .select()
      .from(directorTasksTable)
      .where(and(eq(directorTasksTable.projectId, session.project.id), eq(directorTasksTable.id, taskId)))
      .limit(1);
    const row = rows[0];

    if (!row) {
      throw new Error(`Director task ${taskId} was not found.`);
    }

    await session.db
      .update(directorTasksTable)
      .set({
        status: "resolved",
        updatedAt: nowIso()
      })
      .where(eq(directorTasksTable.id, taskId));

    await recordEvent(session.db, session.project.id, "director_task.resolved", {
      taskId
    });

    const updatedRows = await session.db
      .select()
      .from(directorTasksTable)
      .where(eq(directorTasksTable.id, taskId))
      .limit(1);

    return mapTaskRow(assertPresent(updatedRows[0], `Director task ${taskId} vanished.`));
  });
}

export async function runIssueWorkflow(issueNumber: number): Promise<DirectorOperationResponse> {
  return withProject(async (session) => {
    const issue = assertPresent(
      await getIssueByNumber(session.db, session.project.id, issueNumber),
      `Issue #${issueNumber} was not found in the local mirror. Run \`director sync\` first.`
    );

    const activeIssue =
      issue.workflowState === "ready" || issue.workflowState === "draft"
        ? await updateIssueWorkflow(session, issue, "in_progress")
        : issue;
    const branchName = `codex/issue-${issueNumber}-${slugify(issue.title).slice(0, 36)}`;
    const worktreePath = path.join(session.project.worktreeRoot, `issue-${issueNumber}`);
    const timestamp = nowIso();

    await ensureWorktree(session.project, issueNumber, branchName, worktreePath);

    const existingWorktreeRows = await session.db
      .select()
      .from(worktreesTable)
      .where(eq(worktreesTable.path, worktreePath))
      .limit(1);

    if (existingWorktreeRows[0]) {
      await session.db
        .update(worktreesTable)
        .set({
          issueNumber,
          branchName,
          status: "active",
          updatedAt: timestamp
        })
        .where(eq(worktreesTable.id, existingWorktreeRows[0].id));
    } else {
      await session.db.insert(worktreesTable).values({
        projectId: session.project.id,
        issueNumber,
        branchName,
        path: worktreePath,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    const executorFallback: AgentResultEnvelope = {
      status: "needs_input",
      summary: `Executor prompt prepared for issue #${issueNumber}.`,
      recommended_next_action: "Inspect the worktree changes, run tests, and open a pull request if work was produced.",
      artifact_refs: [worktreePath],
      blocking_questions: []
    };

    const executorResult = await runCodexAgent(
      {
        role: "executor",
        cwd: worktreePath,
        model: session.project.model,
        allowWrite: true,
        prompt: [
          `Implement GitHub issue #${issue.number}: ${issue.title}.`,
          "Read the issue body, make the necessary code changes, and leave the repo in a committable state.",
          "Prefer small, coherent edits and update tests when appropriate.",
          "",
          issue.body
        ].join("\n")
      },
      executorFallback
    );

    try {
      await maybeRunPackageScript(worktreePath, "test");
      await maybeRunPackageScript(worktreePath, "build");
    } catch (error) {
      await insertAgentRun(session.db, {
        projectId: session.project.id,
        role: "executor",
        targetType: "issue",
        targetId: String(issue.number),
        status: "failed",
        inputSummary: issue.title,
        outputSummary: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
        outputJson: executorResult.data ?? null,
        workingDirectory: worktreePath,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      throw error;
    }

    const statusOutput = await runCommand("git", ["status", "--porcelain"], worktreePath);

    if (!statusOutput.trim()) {
      await insertAgentRun(session.db, {
        projectId: session.project.id,
        role: "executor",
        targetType: "issue",
        targetId: String(issue.number),
        status: "needs_input",
        inputSummary: issue.title,
        outputSummary: "Executor completed without producing file changes.",
        outputJson: executorResult.data ?? null,
        workingDirectory: worktreePath,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });

      return {
        ok: true,
        issueNumber,
        branchName,
        worktreePath,
        changed: false
      };
    }

    await runCommand("git", ["add", "-A"], worktreePath);
    await runCommand(
      "git",
      ["commit", "-m", `Implement #${issue.number}: ${issue.title}`],
      worktreePath
    );
    await runCommand("git", ["push", "-u", "origin", branchName], worktreePath);

    const prTitle = `${issue.title}`;
    const prBody = [
      `Implements #${issue.number}`,
      "",
      `Fixes #${issue.number}`,
      "",
      executorResult.summary
    ].join("\n");
    const createdPullRequest = await createPullRequest(worktreePath, {
      baseBranch: session.project.defaultBranch,
      headBranch: branchName,
      title: prTitle,
      body: prBody
    });
    const livePullRequest = await viewPullRequest(worktreePath, createdPullRequest.number);

    await upsertPullRequestMirror(session.db, session.project.id, {
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

    await updateIssueWorkflow(session, activeIssue, "in_review");

    await insertAgentRun(session.db, {
      projectId: session.project.id,
      role: "executor",
      targetType: "issue",
      targetId: String(issue.number),
      status: executorResult.status === "failed" ? "failed" : "succeeded",
      inputSummary: issue.title,
      outputSummary: executorResult.summary,
      outputJson: executorResult.data ?? null,
      workingDirectory: worktreePath,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    await recordEvent(session.db, session.project.id, "issue.pr_opened", {
      issueNumber: issue.number,
      prNumber: createdPullRequest.number,
      branchName
    });

    return {
      ok: true,
      issueNumber,
      branchName,
      worktreePath,
      changed: true,
      pullRequest: createdPullRequest
    };
  });
}

export async function reviewPullRequestWorkflow(
  prNumber: number
): Promise<DirectorOperationResponse> {
  return withProject(async (session) => {
    const pullRequest = await viewPullRequest(session.project.repoPath, prNumber);
    const [diff, checks] = await Promise.all([
      pullRequestDiff(session.project.repoPath, prNumber),
      pullRequestChecks(session.project.repoPath, prNumber)
    ]);

    const allChecksPassing = checks.length === 0 || checks.every((check) => check.bucket === "pass");
    const fallbackReview: AgentResultEnvelope = {
      status: allChecksPassing ? "ok" : "needs_input",
      summary: allChecksPassing
        ? `Pull request #${prNumber} looks ready for merge review.`
        : `Pull request #${prNumber} still has failing or pending checks.`,
      recommended_next_action: allChecksPassing
        ? "Mark the pull request merge-ready."
        : "Resolve checks or code review findings before merging.",
      artifact_refs: [pullRequest.url],
      blocking_questions: allChecksPassing ? [] : ["How should the failing or pending checks be resolved?"]
    };

    const reviewResult = await runCodexAgent(
      {
        role: "reviewer",
        cwd: session.project.repoPath,
        model: session.project.model,
        prompt: [
          `Review GitHub pull request #${pullRequest.number}: ${pullRequest.title}.`,
          "Focus on bugs, regressions, missing tests, and behavior drift.",
          "If no material findings exist, say the pull request is ready for merge.",
          "",
          "Diff:",
          diff
        ].join("\n")
      },
      fallbackReview
    );

    const mergeReady =
      reviewResult.status === "ok" &&
      reviewResult.blocking_questions.length === 0 &&
      allChecksPassing;
    const reviewDecision = mergeReady ? "APPROVED" : "CHANGES_REQUESTED";
    const checksBucket = allChecksPassing ? "pass" : checks.some((check) => check.bucket === "fail") ? "fail" : "pending";
    const commentBody = [
      "## Director OS Review",
      "",
      reviewResult.summary,
      "",
      `Recommended next action: ${reviewResult.recommended_next_action}`,
      reviewResult.blocking_questions.length
        ? `Blocking questions:\n${reviewResult.blocking_questions.map((question) => `- ${question}`).join("\n")}`
        : ""
    ]
      .filter(Boolean)
      .join("\n");

    await commentOnPr(session.project.repoPath, prNumber, commentBody);

    const mirroredPr = await upsertPullRequestMirror(session.db, session.project.id, {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      reviewDecision,
      checksBucket,
      headRefName: pullRequest.headRefName,
      baseRefName: pullRequest.baseRefName,
      url: pullRequest.url,
      linkedIssueNumbers: pullRequest.linkedIssueNumbers,
      updatedAt: pullRequest.updatedAt,
      syncedAt: nowIso()
    });

    if (mergeReady) {
      await ensureDirectorTask(session.db, {
        projectId: session.project.id,
        briefId: null,
        kind: "approve_merge",
        title: `Approve merge for PR #${pullRequest.number}`,
        description: reviewResult.summary,
        recommendation: reviewResult.recommended_next_action,
        status: "ready_for_director",
        payload: {
          prNumber: pullRequest.number,
          url: pullRequest.url
        }
      });
    }

    await insertAgentRun(session.db, {
      projectId: session.project.id,
      role: "reviewer",
      targetType: "pull_request",
      targetId: String(prNumber),
      status: reviewResult.status === "failed" ? "failed" : mergeReady ? "succeeded" : "needs_input",
      inputSummary: pullRequest.title,
      outputSummary: reviewResult.summary,
      outputJson: reviewResult.data ?? null,
      workingDirectory: session.project.repoPath,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    await recordEvent(session.db, session.project.id, "pull_request.reviewed", {
      prNumber,
      mergeReady
    });

    return {
      ok: true,
      mergeReady,
      pullRequest: mirroredPr,
      review: reviewResult
    };
  });
}

export async function mergePullRequestWorkflow(
  prNumber: number
): Promise<DirectorOperationResponse> {
  return withProject(async (session) => {
    const pullRequest = assertPresent(
      await getPullRequestByNumber(session.db, session.project.id, prNumber),
      `Pull request #${prNumber} is missing from the local mirror. Review or sync it first.`
    );

    const checks = await pullRequestChecks(session.project.repoPath, prNumber);
    const hasFailingCheck = checks.some((check) => check.bucket === "fail");
    const hasPendingCheck = checks.some((check) => check.bucket === "pending");

    if (hasFailingCheck || hasPendingCheck) {
      throw new Error(`Pull request #${prNumber} is not mergeable yet because checks are not all passing.`);
    }

    await mergePullRequest(session.project.repoPath, prNumber);

    const updatedPr = await upsertPullRequestMirror(session.db, session.project.id, {
      ...pullRequest,
      state: "merged",
      reviewDecision: pullRequest.reviewDecision ?? "APPROVED",
      checksBucket: "pass",
      syncedAt: nowIso(),
      updatedAt: nowIso()
    });

    await resolveDirectorTasksForPr(session.db, session.project.id, prNumber);

    for (const issueNumber of updatedPr.linkedIssueNumbers) {
      const issue = await getIssueByNumber(session.db, session.project.id, issueNumber);
      if (issue) {
        await upsertIssueMirror(session.db, session.project.id, {
          ...issue,
          state: "closed",
          workflowState: "done",
          labels: [...stripWorkflowLabels(issue.labels), workflowLabel("done")],
          syncedAt: nowIso(),
          updatedAt: nowIso()
        });
      }
    }

    const worktreeRows = await session.db
      .select()
      .from(worktreesTable)
      .where(eq(worktreesTable.branchName, updatedPr.headRefName))
      .limit(1);
    const worktree = worktreeRows[0];

    if (worktree) {
      try {
        await runCommand(
          "git",
          ["-C", session.project.repoPath, "worktree", "remove", "--force", worktree.path],
          session.project.repoPath
        );
      } catch {
        // Keep the local row marked for cleanup if removal fails.
      }

      await session.db
        .update(worktreesTable)
        .set({
          status: "cleaned",
          updatedAt: nowIso()
        })
        .where(eq(worktreesTable.id, worktree.id));
    }

    await recordEvent(session.db, session.project.id, "pull_request.merged", {
      prNumber
    });

    return {
      ok: true,
      prNumber
    };
  });
}
