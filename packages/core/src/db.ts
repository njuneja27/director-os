import fs from "node:fs/promises";

import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { ensureRuntimeDirectories, resolveRuntimePaths, type RuntimePaths } from "./config.js";

const CURRENT_SCHEMA_VERSION = 5;
const jsonText = (name: string) => text(name, { mode: "json" });

export const projectsTable = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repoPath: text("repo_path").notNull(),
    repoSlug: text("repo_slug").notNull(),
    defaultBranch: text("default_branch").notNull(),
    worktreeRoot: text("worktree_root").notNull(),
    agentRunner: text("agent_runner").notNull(),
    model: text("model").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    slugIdx: uniqueIndex("projects_slug_idx").on(table.slug)
  })
);

export const orchestratorStateTable = sqliteTable(
  "orchestrator_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    status: text("status").notNull(),
    pauseReason: text("pause_reason"),
    activeRunIds: jsonText("active_run_ids").notNull(),
    lastLoopAt: text("last_loop_at"),
    lastSummary: text("last_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    orchestratorProjectIdx: uniqueIndex("orchestrator_state_project_idx").on(table.projectId)
  })
);

export const directorNotesTable = sqliteTable("director_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const conversationThreadsTable = sqliteTable(
  "conversation_threads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    conversationProjectIdx: uniqueIndex("conversation_threads_project_idx").on(table.projectId)
  })
);

export const conversationMessagesTable = sqliteTable("conversation_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: integer("thread_id").notNull(),
  projectId: integer("project_id").notNull(),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  summary: text("summary"),
  linkedIssueNumber: integer("linked_issue_number"),
  linkedPrNumber: integer("linked_pr_number"),
  isOpenQuestion: integer("is_open_question", { mode: "boolean" }).notNull().default(false),
  workItemId: integer("work_item_id"),
  issueNumber: integer("issue_number"),
  prNumber: integer("pr_number"),
  decisionId: integer("decision_id"),
  runId: integer("run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const workItemsTable = sqliteTable(
  "work_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    issueNumber: integer("issue_number").notNull(),
    parentIssueNumber: integer("parent_issue_number"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    kind: text("kind").notNull(),
    executionMode: text("execution_mode").notNull(),
    ownerRole: text("owner_role").notNull(),
    status: text("status").notNull(),
    priorityBucket: integer("priority_bucket").notNull(),
    activeRunId: integer("active_run_id"),
    activePrNumber: integer("active_pr_number"),
    lastSummary: text("last_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    workItemIssueIdx: uniqueIndex("work_items_project_issue_idx").on(table.projectId, table.issueNumber)
  })
);

export const runsTable = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  workItemId: integer("work_item_id"),
  issueNumber: integer("issue_number"),
  prNumber: integer("pr_number"),
  role: text("role").notNull(),
  status: text("status").notNull(),
  phase: text("phase").notNull(),
  summary: text("summary").notNull(),
  recommendedNextAction: text("recommended_next_action"),
  artifacts: jsonText("artifacts").notNull(),
  blockingQuestions: jsonText("blocking_questions").notNull(),
  outputJson: jsonText("output_json"),
  rawModelOutput: text("raw_model_output"),
  worktreePath: text("worktree_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const decisionsTable = sqliteTable("decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  workItemId: integer("work_item_id"),
  issueNumber: integer("issue_number"),
  prNumber: integer("pr_number"),
  requestedByRunId: integer("requested_by_run_id"),
  questionMessageId: integer("question_message_id"),
  resolutionMessageId: integer("resolution_message_id"),
  target: text("target").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  recommendation: text("recommendation").notNull(),
  rationale: text("rationale").notNull(),
  status: text("status").notNull(),
  resolution: text("resolution"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const prCyclesTable = sqliteTable(
  "pr_cycles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    issueNumber: integer("issue_number").notNull(),
    prNumber: integer("pr_number").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    automationWindowEndsAt: text("automation_window_ends_at"),
    lastCheckedAt: text("last_checked_at"),
    lastHandledCommentAt: text("last_handled_comment_at"),
    mergedAt: text("merged_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    prCycleIdx: uniqueIndex("pr_cycles_project_pr_idx").on(table.projectId, table.prNumber)
  })
);

export const eventsTable = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonText("payload").notNull(),
  createdAt: text("created_at").notNull()
});

export const worktreesTable = sqliteTable(
  "worktrees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    issueNumber: integer("issue_number"),
    branchName: text("branch_name").notNull(),
    path: text("path").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    pathIdx: uniqueIndex("worktrees_path_idx").on(table.path)
  })
);

export const githubIssuesTable = sqliteTable(
  "github_issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    state: text("state").notNull(),
    workflowState: text("workflow_state").notNull(),
    labels: jsonText("labels").notNull(),
    url: text("url").notNull(),
    updatedAt: text("updated_at").notNull(),
    syncedAt: text("synced_at").notNull()
  },
  (table) => ({
    issueIdx: uniqueIndex("github_issues_project_number_idx").on(table.projectId, table.number)
  })
);

export const githubPullRequestsTable = sqliteTable(
  "github_pull_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    state: text("state").notNull(),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull(),
    reviewDecision: text("review_decision"),
    checksBucket: text("checks_bucket"),
    headRefName: text("head_ref_name").notNull(),
    baseRefName: text("base_ref_name").notNull(),
    url: text("url").notNull(),
    linkedIssueNumbers: jsonText("linked_issue_numbers").notNull(),
    updatedAt: text("updated_at").notNull(),
    syncedAt: text("synced_at").notNull()
  },
  (table) => ({
    prIdx: uniqueIndex("github_prs_project_number_idx").on(table.projectId, table.number)
  })
);

export const githubCommentsTable = sqliteTable(
  "github_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    githubId: text("github_id").notNull(),
    parentType: text("parent_type").notNull(),
    parentNumber: integer("parent_number").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    url: text("url").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    syncedAt: text("synced_at").notNull()
  },
  (table) => ({
    githubCommentIdx: uniqueIndex("github_comments_github_id_idx").on(table.githubId)
  })
);

export const schema = {
  projectsTable,
  orchestratorStateTable,
  directorNotesTable,
  conversationThreadsTable,
  conversationMessagesTable,
  workItemsTable,
  runsTable,
  decisionsTable,
  prCyclesTable,
  eventsTable,
  worktreesTable,
  githubIssuesTable,
  githubPullRequestsTable,
  githubCommentsTable
};

export type DirectorDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseResult {
  sqlite: Database.Database;
  db: DirectorDatabase;
  paths: RuntimePaths;
}

const bootstrapSql = `
create table if not exists projects (
  id integer primary key autoincrement,
  name text not null,
  slug text not null unique,
  repo_path text not null,
  repo_slug text not null,
  default_branch text not null,
  worktree_root text not null,
  agent_runner text not null,
  model text not null,
  created_at text not null,
  updated_at text not null
);
create table if not exists orchestrator_state (
  id integer primary key autoincrement,
  project_id integer not null,
  status text not null,
  pause_reason text,
  active_run_ids text not null,
  last_loop_at text,
  last_summary text,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists orchestrator_state_project_idx on orchestrator_state(project_id);
create table if not exists director_notes (
  id integer primary key autoincrement,
  project_id integer not null,
  content text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);
create table if not exists conversation_threads (
  id integer primary key autoincrement,
  project_id integer not null,
  title text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists conversation_threads_project_idx on conversation_threads(project_id);
create table if not exists conversation_messages (
  id integer primary key autoincrement,
  thread_id integer not null,
  project_id integer not null,
  role text not null,
  kind text not null,
  content text not null,
  summary text,
  linked_issue_number integer,
  linked_pr_number integer,
  is_open_question integer not null default 0,
  work_item_id integer,
  issue_number integer,
  pr_number integer,
  decision_id integer,
  run_id integer,
  created_at text not null,
  updated_at text not null
);
create table if not exists work_items (
  id integer primary key autoincrement,
  project_id integer not null,
  issue_number integer not null,
  parent_issue_number integer,
  title text not null,
  summary text not null,
  kind text not null,
  execution_mode text not null,
  owner_role text not null,
  status text not null,
  priority_bucket integer not null,
  active_run_id integer,
  active_pr_number integer,
  last_summary text,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists work_items_project_issue_idx on work_items(project_id, issue_number);
create table if not exists runs (
  id integer primary key autoincrement,
  project_id integer not null,
  work_item_id integer,
  issue_number integer,
  pr_number integer,
  role text not null,
  status text not null,
  phase text not null,
  summary text not null,
  recommended_next_action text,
  artifacts text not null,
  blocking_questions text not null,
  output_json text,
  raw_model_output text,
  worktree_path text,
  created_at text not null,
  updated_at text not null
);
create table if not exists decisions (
  id integer primary key autoincrement,
  project_id integer not null,
  work_item_id integer,
  issue_number integer,
  pr_number integer,
  requested_by_run_id integer,
  question_message_id integer,
  resolution_message_id integer,
  target text not null,
  title text not null,
  summary text not null,
  recommendation text not null,
  rationale text not null,
  status text not null,
  resolution text,
  created_at text not null,
  updated_at text not null
);
create table if not exists pr_cycles (
  id integer primary key autoincrement,
  project_id integer not null,
  issue_number integer not null,
  pr_number integer not null,
  status text not null,
  summary text not null,
  automation_window_ends_at text,
  last_checked_at text,
  last_handled_comment_at text,
  merged_at text,
  created_at text not null,
  updated_at text not null
);
create unique index if not exists pr_cycles_project_pr_idx on pr_cycles(project_id, pr_number);
create table if not exists events (
  id integer primary key autoincrement,
  project_id integer not null,
  kind text not null,
  payload text not null,
  created_at text not null
);
create table if not exists worktrees (
  id integer primary key autoincrement,
  project_id integer not null,
  issue_number integer,
  branch_name text not null,
  path text not null unique,
  status text not null,
  created_at text not null,
  updated_at text not null
);
create table if not exists github_issues (
  id integer primary key autoincrement,
  project_id integer not null,
  number integer not null,
  title text not null,
  body text not null,
  state text not null,
  workflow_state text not null,
  labels text not null,
  url text not null,
  updated_at text not null,
  synced_at text not null
);
create unique index if not exists github_issues_project_number_idx on github_issues(project_id, number);
create table if not exists github_pull_requests (
  id integer primary key autoincrement,
  project_id integer not null,
  number integer not null,
  title text not null,
  body text not null,
  state text not null,
  is_draft integer not null,
  review_decision text,
  checks_bucket text,
  head_ref_name text not null,
  base_ref_name text not null,
  url text not null,
  linked_issue_numbers text not null,
  updated_at text not null,
  synced_at text not null
);
create unique index if not exists github_prs_project_number_idx on github_pull_requests(project_id, number);
create table if not exists github_comments (
  id integer primary key autoincrement,
  project_id integer not null,
  github_id text not null unique,
  parent_type text not null,
  parent_number integer not null,
  author text not null,
  body text not null,
  url text not null,
  created_at text not null,
  updated_at text not null,
  synced_at text not null
);
`;

export async function openDatabase(paths = resolveRuntimePaths()): Promise<OpenDatabaseResult> {
  await ensureRuntimeDirectories(paths);
  await fs.mkdir(paths.homeDir, { recursive: true });

  const sqlite = new Database(paths.databasePath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    paths
  };
}

function columnExists(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  const rows = sqlite.pragma(`table_info(${tableName})`) as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

export function migrateDatabase(sqlite: Database.Database): void {
  const version = Number(sqlite.pragma("user_version", { simple: true }) ?? 0);

  if (version < CURRENT_SCHEMA_VERSION) {
    sqlite.exec(`
      drop table if exists briefs;
      drop table if exists epics;
      drop table if exists director_tasks;
      drop table if exists agent_runs;
    `);
  }

  sqlite.exec(bootstrapSql);

  if (!columnExists(sqlite, "conversation_threads", "status")) {
    sqlite.exec("alter table conversation_threads add column status text not null default 'active';");
  }
  if (!columnExists(sqlite, "conversation_messages", "summary")) {
    sqlite.exec("alter table conversation_messages add column summary text;");
  }
  if (!columnExists(sqlite, "conversation_messages", "linked_issue_number")) {
    sqlite.exec("alter table conversation_messages add column linked_issue_number integer;");
  }
  if (!columnExists(sqlite, "conversation_messages", "linked_pr_number")) {
    sqlite.exec("alter table conversation_messages add column linked_pr_number integer;");
  }
  if (!columnExists(sqlite, "conversation_messages", "is_open_question")) {
    sqlite.exec("alter table conversation_messages add column is_open_question integer not null default 0;");
  }
  if (!columnExists(sqlite, "decisions", "requested_by_run_id")) {
    sqlite.exec("alter table decisions add column requested_by_run_id integer;");
  }
  if (!columnExists(sqlite, "decisions", "question_message_id")) {
    sqlite.exec("alter table decisions add column question_message_id integer;");
  }
  if (!columnExists(sqlite, "decisions", "resolution_message_id")) {
    sqlite.exec("alter table decisions add column resolution_message_id integer;");
  }
  if (!columnExists(sqlite, "runs", "raw_model_output")) {
    sqlite.exec("alter table runs add column raw_model_output text;");
  }
  sqlite.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

export function asJson<TValue>(value: TValue): TValue {
  return value;
}

export function fromJson<TValue>(value: TValue): TValue {
  return value;
}
