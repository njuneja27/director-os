import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConversationMessageRecord,
  ConversationThreadRecord,
  OrchestratorStatus,
  PrSweepStatus,
  RunRecord
} from "@director-os/shared";

import { nowIso, type RuntimePaths } from "./config.js";
import type { RemoteComment, RemoteIssue, RemotePullRequest } from "./github.js";

export interface RouterLaneState {
  id: string;
  name: string;
  sessionId: string | null;
  issueNumbers: number[];
  status: "idle" | "planning" | "implementing" | "waiting_review" | "blocked";
  currentIssueNumber: number | null;
  activePullRequestNumber: number | null;
  lastSummary: string | null;
  lastPlanSummary: string | null;
  updatedAt: string;
}

export interface RouterQuestionState {
  id: string;
  title: string;
  summary: string;
  question: string;
  whyItMatters: string;
  recommendation: string;
  issueNumber: number | null;
  prNumber: number | null;
  runId: number | null;
  requestedBy: "chief_of_staff" | "lane" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface RouterHandoffState {
  id: string;
  laneId: string;
  issueNumber: number;
  kind: "plan" | "implement" | "review";
  status: "pending" | "in_progress" | "completed" | "blocked";
  summary: string | null;
  prNumber: number | null;
  branchName: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  startedBy: string | null;
  startedByPid: number | null;
  reviewWindowEndsAt: string | null;
  lastHandledCommentAt: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouterPrSweepState {
  status: PrSweepStatus;
  nextRunAt: string | null;
  currentPullRequestNumber: number | null;
  pendingPullRequestNumbers: number[];
  blockerIssueNumbers: number[];
  waitingOnIssueNumber: number | null;
  startedAt: string | null;
  completedAt: string | null;
  lastSummary: string | null;
  pausedIssueWork: boolean;
  updatedAt: string | null;
}

export interface RouterState {
  version: number;
  projectSlug: string;
  orchestrator: {
    status: OrchestratorStatus;
    pauseReason: string | null;
    lastLoopAt: string | null;
    lastSummary: string | null;
  };
  chiefOfStaff: {
    sessionId: string | null;
    lastSummary: string | null;
    updatedAt: string | null;
  };
  lanes: RouterLaneState[];
  issueOwnership: Record<string, string>;
  pendingHandoffs: RouterHandoffState[];
  prSweep: RouterPrSweepState;
  openQuestion: RouterQuestionState | null;
  recentRuns: RunRecord[];
  lastSyncAt: string | null;
  updatedAt: string;
}

export interface GitHubCacheState {
  version: number;
  syncedAt: string | null;
  issues: RemoteIssue[];
  pullRequests: RemotePullRequest[];
  comments: RemoteComment[];
}

export interface ConversationState {
  version: number;
  thread: ConversationThreadRecord | null;
  messages: ConversationMessageRecord[];
}

function projectRuntimeDir(paths: RuntimePaths, projectSlug: string): string {
  return path.join(paths.runtimeDir, projectSlug);
}

function routerStatePath(paths: RuntimePaths, projectSlug: string): string {
  return path.join(projectRuntimeDir(paths, projectSlug), "router-state.json");
}

function conversationPath(paths: RuntimePaths, projectSlug: string): string {
  return path.join(projectRuntimeDir(paths, projectSlug), "conversation.json");
}

function githubCachePath(paths: RuntimePaths, projectSlug: string): string {
  return path.join(projectRuntimeDir(paths, projectSlug), "github-cache.json");
}

async function ensureProjectRuntimeDir(paths: RuntimePaths, projectSlug: string): Promise<string> {
  const runtimeDir = projectRuntimeDir(paths, projectSlug);
  await fs.mkdir(runtimeDir, { recursive: true });
  return runtimeDir;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<TValue>(targetPath: string, fallback: TValue): Promise<TValue> {
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as TValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createDefaultRouterState(projectSlug: string): RouterState {
  const timestamp = nowIso();
  return {
    version: 1,
    projectSlug,
    orchestrator: {
      status: "idle",
      pauseReason: null,
      lastLoopAt: null,
      lastSummary: "Chief of Staff is ready."
    },
    chiefOfStaff: {
      sessionId: null,
      lastSummary: null,
      updatedAt: null
    },
    lanes: [],
    issueOwnership: {},
    pendingHandoffs: [],
    prSweep: {
      status: "idle",
      nextRunAt: null,
      currentPullRequestNumber: null,
      pendingPullRequestNumbers: [],
      blockerIssueNumbers: [],
      waitingOnIssueNumber: null,
      startedAt: null,
      completedAt: null,
      lastSummary: "Chief of Staff will schedule PR sweeps as needed.",
      pausedIssueWork: false,
      updatedAt: timestamp
    },
    openQuestion: null,
    recentRuns: [],
    lastSyncAt: null,
    updatedAt: timestamp
  };
}

export function createDefaultConversationState(project: {
  name: string;
}): ConversationState {
  const timestamp = nowIso();
  return {
    version: 1,
    thread: {
      id: 1,
      projectId: 0,
      title: `${project.name} Chief of Staff`,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    messages: []
  };
}

export function createDefaultGitHubCacheState(): GitHubCacheState {
  return {
    version: 1,
    syncedAt: null,
    issues: [],
    pullRequests: [],
    comments: []
  };
}

export async function initializeProjectRuntime(
  paths: RuntimePaths,
  project: {
    name: string;
    slug: string;
  }
): Promise<void> {
  await ensureProjectRuntimeDir(paths, project.slug);

  if (!(await pathExists(routerStatePath(paths, project.slug)))) {
    await saveRouterState(paths, createDefaultRouterState(project.slug));
  }

  if (!(await pathExists(conversationPath(paths, project.slug)))) {
    await saveConversationState(paths, createDefaultConversationState(project), project.slug);
  }

  if (!(await pathExists(githubCachePath(paths, project.slug)))) {
    await saveGitHubCacheState(paths, createDefaultGitHubCacheState(), project.slug);
  }
}

export async function loadRouterState(paths: RuntimePaths, projectSlug: string): Promise<RouterState> {
  await ensureProjectRuntimeDir(paths, projectSlug);
  const fallback = createDefaultRouterState(projectSlug);
  const state = await readJsonFile(routerStatePath(paths, projectSlug), fallback);
  return {
    ...fallback,
    ...state,
    orchestrator: {
      ...fallback.orchestrator,
      ...(state as Partial<RouterState>).orchestrator
    },
    chiefOfStaff: {
      ...fallback.chiefOfStaff,
      ...(state as Partial<RouterState>).chiefOfStaff
    },
    lanes: Array.isArray(state.lanes)
      ? state.lanes.map((lane) => ({
          ...lane,
          currentIssueNumber: lane.currentIssueNumber ?? null,
          activePullRequestNumber: lane.activePullRequestNumber ?? null,
          lastPlanSummary: lane.lastPlanSummary ?? null
        }))
      : [],
    issueOwnership:
      state.issueOwnership && typeof state.issueOwnership === "object" ? state.issueOwnership : {},
    pendingHandoffs: Array.isArray(state.pendingHandoffs)
      ? state.pendingHandoffs.map((handoff) => ({
          ...handoff,
          prNumber: handoff.prNumber ?? null,
          branchName: handoff.branchName ?? null,
          worktreePath: handoff.worktreePath ?? null,
          startedAt: handoff.startedAt ?? null,
          startedBy: handoff.startedBy ?? null,
          startedByPid: handoff.startedByPid ?? null,
          reviewWindowEndsAt: handoff.reviewWindowEndsAt ?? null,
          lastHandledCommentAt: handoff.lastHandledCommentAt ?? null,
          details: handoff.details ?? null
        }))
      : [],
    prSweep: {
      ...fallback.prSweep,
      ...(state as Partial<RouterState>).prSweep,
      pendingPullRequestNumbers: Array.isArray(state.prSweep?.pendingPullRequestNumbers)
        ? state.prSweep.pendingPullRequestNumbers
        : [],
      blockerIssueNumbers: Array.isArray(state.prSweep?.blockerIssueNumbers)
        ? state.prSweep.blockerIssueNumbers
        : []
    },
    recentRuns: Array.isArray(state.recentRuns) ? state.recentRuns : []
  };
}

export async function saveRouterState(
  paths: RuntimePaths,
  state: RouterState
): Promise<RouterState> {
  await ensureProjectRuntimeDir(paths, state.projectSlug);
  const nextState: RouterState = {
    ...state,
    recentRuns: state.recentRuns.slice(-20),
    updatedAt: nowIso()
  };
  await writeJsonFile(routerStatePath(paths, state.projectSlug), nextState);
  return nextState;
}

export async function updateRouterState(
  paths: RuntimePaths,
  projectSlug: string,
  updater: (state: RouterState) => RouterState
): Promise<RouterState> {
  const current = await loadRouterState(paths, projectSlug);
  return saveRouterState(paths, updater(current));
}

export async function loadConversationState(
  paths: RuntimePaths,
  project: {
    name: string;
    slug: string;
  }
): Promise<ConversationState> {
  await ensureProjectRuntimeDir(paths, project.slug);
  const fallback = createDefaultConversationState(project);
  const state = await readJsonFile(conversationPath(paths, project.slug), fallback);
  return {
    ...fallback,
    ...state,
    messages: Array.isArray(state.messages) ? state.messages : []
  };
}

export async function saveConversationState(
  paths: RuntimePaths,
  state: ConversationState,
  projectSlug: string
): Promise<ConversationState> {
  await ensureProjectRuntimeDir(paths, projectSlug);
  const nextState: ConversationState = {
    ...state,
    thread: state.thread
      ? {
          ...state.thread,
          updatedAt: nowIso()
        }
      : null
  };
  await writeJsonFile(conversationPath(paths, projectSlug), nextState);
  return nextState;
}

export async function loadGitHubCacheState(
  paths: RuntimePaths,
  projectSlug: string
): Promise<GitHubCacheState> {
  await ensureProjectRuntimeDir(paths, projectSlug);
  const fallback = createDefaultGitHubCacheState();
  const state = await readJsonFile(githubCachePath(paths, projectSlug), fallback);
  return {
    ...fallback,
    ...state,
    issues: Array.isArray(state.issues) ? state.issues : [],
    pullRequests: Array.isArray(state.pullRequests) ? state.pullRequests : [],
    comments: Array.isArray(state.comments) ? state.comments : []
  };
}

export async function saveGitHubCacheState(
  paths: RuntimePaths,
  state: GitHubCacheState,
  projectSlug: string
): Promise<GitHubCacheState> {
  await ensureProjectRuntimeDir(paths, projectSlug);
  await writeJsonFile(githubCachePath(paths, projectSlug), state);
  return state;
}
