export const WORKFLOW_STATES = [
  "draft",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done"
] as const;

export const BRIEF_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "superseded"
] as const;

export const DIRECTOR_TASK_STATUSES = [
  "queued",
  "ready_for_director",
  "resolved"
] as const;

export const DIRECTOR_TASK_KINDS = [
  "approve_brief",
  "answer_question",
  "test_flow",
  "approve_merge",
  "advise"
] as const;

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_input"
] as const;

export const SETUP_CHECK_KINDS = [
  "repository",
  "github",
  "codex",
  "workspace"
] as const;

export const SETUP_CHECK_STATUSES = [
  "ready",
  "needs_action",
  "blocked",
  "waiting"
] as const;

export const SETUP_PROBLEM_CODES = [
  "repo_missing",
  "repo_not_absolute",
  "repo_not_found",
  "repo_not_git",
  "repo_slug_missing",
  "default_branch_missing",
  "gh_missing",
  "gh_auth_required",
  "gh_probe_failed",
  "codex_missing",
  "codex_sign_in_required",
  "codex_probe_failed",
  "workspace_unwritable",
  "workspace_probe_failed"
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
export type DirectorTaskStatus = (typeof DIRECTOR_TASK_STATUSES)[number];
export type DirectorTaskKind = (typeof DIRECTOR_TASK_KINDS)[number];
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type SetupCheckKind = (typeof SETUP_CHECK_KINDS)[number];
export type SetupCheckStatus = (typeof SETUP_CHECK_STATUSES)[number];
export type SetupProblemCode = (typeof SETUP_PROBLEM_CODES)[number];

export type BriefAction = "approve" | "revise" | "reject";
export type DirectorTaskAction = "approve" | "reject" | "resolve";

export const DIRECTOR_LABEL_PREFIX = "director:";

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
  repoPath: string;
  repoSlug: string;
  defaultBranch: string;
  worktreeRoot: string;
  agentRunner: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntakeMessage {
  role: "director" | "chief_of_staff";
  content: string;
  createdAt: string;
}

export interface BriefDraft {
  title: string;
  problem: string;
  targetUser: string;
  desiredOutcome: string;
  constraints: string[];
  nonGoals: string[];
  successMetrics: string[];
}

export interface BriefRecord {
  id: number;
  projectId: number;
  title: string;
  status: BriefStatus;
  summary: string;
  draft: BriefDraft;
  transcript: IntakeMessage[];
  githubEpicNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRecord {
  id: number;
  projectId: number;
  briefId: number;
  title: string;
  summary: string;
  status: string;
  githubIssueNumber: number | null;
  childIssueNumbers: number[];
  createdAt: string;
  updatedAt: string;
}

export interface DirectorTaskRecord {
  id: number;
  projectId: number;
  briefId: number | null;
  kind: DirectorTaskKind;
  title: string;
  description: string;
  recommendation: string;
  status: DirectorTaskStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueRecord {
  id: number;
  projectId: number;
  number: number;
  title: string;
  body: string;
  state: string;
  workflowState: WorkflowState;
  labels: string[];
  url: string;
  updatedAt: string;
  syncedAt: string;
}

export interface GitHubPullRequestRecord {
  id: number;
  projectId: number;
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  checksBucket: string | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  linkedIssueNumbers: number[];
  updatedAt: string;
  syncedAt: string;
}

export interface AgentRunRecord {
  id: number;
  projectId: number;
  role: string;
  targetType: string;
  targetId: string;
  status: AgentRunStatus;
  inputSummary: string;
  outputSummary: string;
  outputJson: Record<string, unknown> | null;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentResultEnvelope {
  status: "ok" | "needs_input" | "failed";
  summary: string;
  recommended_next_action: string;
  artifact_refs: string[];
  blocking_questions: string[];
  data?: Record<string, unknown>;
}

export interface SetupCheck {
  kind: SetupCheckKind;
  status: SetupCheckStatus;
  title: string;
  detail: string;
  code: SetupProblemCode | null;
  recommendedAction: string | null;
  advancedDetail?: string | null;
}

export interface SetupRepositoryDraft {
  repoPath: string;
  projectName: string;
  repoSlug: string;
  defaultBranch: string;
  worktreeRoot: string;
  agentRunner: string;
  model: string;
}

export interface SetupProbeRepositoryInput {
  repoPath: string;
  projectName?: string;
  worktreeRoot?: string;
  model?: string;
}

export interface SetupStatusResponse {
  activeProject: ProjectRecord | null;
  checks: SetupCheck[];
  repositoryDraft: SetupRepositoryDraft | null;
  canComplete: boolean;
  completed: boolean;
}

export interface HomeOverview {
  project: ProjectRecord | null;
  counts: {
    pendingDirectorTasks: number;
    activeBriefs: number;
    readyIssues: number;
    inReviewIssues: number;
    openPullRequests: number;
  };
  pendingTasks: DirectorTaskRecord[];
  activeIssues: GitHubIssueRecord[];
  openPullRequests: GitHubPullRequestRecord[];
  recentRuns: AgentRunRecord[];
  latestBrief: BriefRecord | null;
}

export interface InboxResponse {
  tasks: DirectorTaskRecord[];
}

export interface IntakeResponse {
  project: ProjectRecord | null;
  brief: BriefRecord | null;
}

export interface DirectorOperationResponse {
  ok: boolean;
  [key: string]: unknown;
}

export interface DirectorClient {
  getSetupStatus(): Promise<SetupStatusResponse>;
  probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
  runWorkspaceTest(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  completeSetup(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  getOverview(): Promise<HomeOverview>;
  getInbox(): Promise<InboxResponse>;
  getIntake(): Promise<IntakeResponse>;
  submitIntakeMessage(content: string): Promise<BriefRecord>;
  actOnBrief(briefId: number, action: BriefAction): Promise<BriefRecord>;
  actOnTask(taskId: number, action: DirectorTaskAction): Promise<DirectorTaskRecord>;
  sync(): Promise<DirectorOperationResponse>;
  runIssue(issueNumber: number): Promise<DirectorOperationResponse>;
  reviewPr(prNumber: number): Promise<DirectorOperationResponse>;
  mergePr(prNumber: number): Promise<DirectorOperationResponse>;
}

export interface DirectorDesktopBridge {
  setup: {
    getStatus(): Promise<SetupStatusResponse>;
    probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
    runWorkspaceTest(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
    complete(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  };
  director: {
    getOverview(): Promise<HomeOverview>;
    getInbox(): Promise<InboxResponse>;
    getIntake(): Promise<IntakeResponse>;
    submitIntakeMessage(content: string): Promise<BriefRecord>;
    actOnBrief(briefId: number, action: BriefAction): Promise<BriefRecord>;
    actOnTask(taskId: number, action: DirectorTaskAction): Promise<DirectorTaskRecord>;
    sync(): Promise<DirectorOperationResponse>;
    runIssue(issueNumber: number): Promise<DirectorOperationResponse>;
    reviewPr(prNumber: number): Promise<DirectorOperationResponse>;
    mergePr(prNumber: number): Promise<DirectorOperationResponse>;
  };
}

export interface InitCommandOptions {
  projectName?: string;
  repoPath?: string;
  repoSlug?: string;
  defaultBranch?: string;
  worktreeRoot?: string;
  agentRunner?: string;
  model?: string;
  skipGhCheck?: boolean;
  noProjectRegistration?: boolean;
}
