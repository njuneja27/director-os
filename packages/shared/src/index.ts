export const WORK_ITEM_KINDS = ["workstream", "task"] as const;
export const WORK_ITEM_STATUSES = [
  "queued",
  "planning",
  "ready",
  "running",
  "waiting_review",
  "waiting_decision",
  "completed",
  "blocked"
] as const;
export const EXECUTION_MODES = ["lane", "worker"] as const;
export const RUN_ROLES = [
  "chief_of_staff",
  "lane_owner",
  "worker",
  "reviewer",
  "validator",
  "pr_watcher"
] as const;
export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_input"
] as const;
export const DECISION_TARGETS = ["chief_of_staff", "human_director"] as const;
export const DECISION_STATUSES = ["open", "resolved", "dismissed"] as const;
export const ORCHESTRATOR_STATUSES = ["idle", "running", "paused", "blocked"] as const;
export const NOTE_STATUSES = ["active", "archived"] as const;
export const CONVERSATION_MESSAGE_ROLES = ["director", "chief_of_staff", "system"] as const;
export const CONVERSATION_MESSAGE_KINDS = [
  "human_message",
  "cos_reply",
  "cos_question",
  "status_update",
  "resolution"
] as const;
export const PR_CYCLE_STATUSES = [
  "opened",
  "waiting_automation",
  "changes_requested",
  "revalidating",
  "cos_review",
  "merge_ready",
  "merged",
  "blocked"
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

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type RunRole = (typeof RUN_ROLES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type DecisionTarget = (typeof DECISION_TARGETS)[number];
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type OrchestratorStatus = (typeof ORCHESTRATOR_STATUSES)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type ConversationMessageRole = (typeof CONVERSATION_MESSAGE_ROLES)[number];
export type ConversationMessageKind = (typeof CONVERSATION_MESSAGE_KINDS)[number];
export type PrCycleStatus = (typeof PR_CYCLE_STATUSES)[number];
export type SetupCheckKind = (typeof SETUP_CHECK_KINDS)[number];
export type SetupCheckStatus = (typeof SETUP_CHECK_STATUSES)[number];
export type SetupProblemCode = (typeof SETUP_PROBLEM_CODES)[number];

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

export interface GitHubIssueRecord {
  id: number;
  projectId: number;
  number: number;
  title: string;
  body: string;
  state: string;
  workflowState: string;
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

export interface WorkItemRecord {
  id: number;
  projectId: number;
  issueNumber: number;
  parentIssueNumber: number | null;
  title: string;
  summary: string;
  kind: WorkItemKind;
  executionMode: ExecutionMode;
  ownerRole: string;
  status: WorkItemStatus;
  priorityBucket: number;
  activeRunId: number | null;
  activePrNumber: number | null;
  lastSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: number;
  projectId: number;
  workItemId: number | null;
  issueNumber: number | null;
  prNumber: number | null;
  role: RunRole;
  status: RunStatus;
  phase: string;
  summary: string;
  recommendedNextAction: string | null;
  artifacts: string[];
  blockingQuestions: string[];
  outputJson: Record<string, unknown> | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionRecord {
  id: number;
  projectId: number;
  workItemId: number | null;
  issueNumber: number | null;
  prNumber: number | null;
  requestedByRunId: number | null;
  questionMessageId: number | null;
  resolutionMessageId: number | null;
  target: DecisionTarget;
  title: string;
  summary: string;
  recommendation: string;
  rationale: string;
  status: DecisionStatus;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorNoteRecord {
  id: number;
  projectId: number;
  content: string;
  status: NoteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationThreadRecord {
  id: number;
  projectId: number;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  id: number;
  projectId: number;
  threadId: number;
  role: ConversationMessageRole;
  kind: ConversationMessageKind;
  content: string;
  summary: string | null;
  linkedIssueNumber: number | null;
  linkedPrNumber: number | null;
  isOpenQuestion: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrCycleRecord {
  id: number;
  projectId: number;
  issueNumber: number;
  prNumber: number;
  status: PrCycleStatus;
  summary: string;
  automationWindowEndsAt: string | null;
  lastCheckedAt: string | null;
  lastHandledCommentAt: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorStatusRecord {
  id: number;
  projectId: number;
  status: OrchestratorStatus;
  pauseReason: string | null;
  activeRunIds: number[];
  lastLoopAt: string | null;
  lastSummary: string | null;
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

export interface DirectorStatusResponse {
  project: ProjectRecord | null;
  orchestrator: OrchestratorStatusRecord | null;
  queue: WorkItemRecord[];
  activeWork: WorkItemRecord[];
  decisions: DecisionRecord[];
  prCycles: PrCycleRecord[];
  recentRuns: RunRecord[];
  notes: DirectorNoteRecord[];
  openPullRequests: GitHubPullRequestRecord[];
}

export interface ConversationResponse {
  thread: ConversationThreadRecord | null;
  messages: ConversationMessageRecord[];
  openQuestion: ConversationMessageRecord | null;
  latestSummary: string | null;
}

export interface DecisionsResponse {
  decisions: DecisionRecord[];
}

export interface DirectorOperationResponse {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface DirectorClient {
  getSetupStatus(): Promise<SetupStatusResponse>;
  probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
  runWorkspaceTest(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  completeSetup(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  getConversation(): Promise<ConversationResponse>;
  sendMessage(content: string): Promise<ConversationResponse>;
  getStatus(): Promise<DirectorStatusResponse>;
  start(): Promise<DirectorOperationResponse>;
  pause(reason?: string): Promise<DirectorOperationResponse>;
  sync(): Promise<DirectorOperationResponse>;
  submitNote(content: string): Promise<DirectorNoteRecord>;
  listDecisions(): Promise<DecisionsResponse>;
  resolveDecision(decisionId: number, resolution: string): Promise<DecisionRecord>;
}

export interface DirectorDesktopBridge {
  conversation: {
    getConversation(): Promise<ConversationResponse>;
    sendMessage(content: string): Promise<ConversationResponse>;
  };
  setup: {
    getStatus(): Promise<SetupStatusResponse>;
    probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
    runWorkspaceTest(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
    complete(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  };
  director: {
    getStatus(): Promise<DirectorStatusResponse>;
    start(): Promise<DirectorOperationResponse>;
    pause(reason?: string): Promise<DirectorOperationResponse>;
    sync(): Promise<DirectorOperationResponse>;
    submitNote(content: string): Promise<DirectorNoteRecord>;
    listDecisions(): Promise<DecisionsResponse>;
    resolveDecision(decisionId: number, resolution: string): Promise<DecisionRecord>;
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
