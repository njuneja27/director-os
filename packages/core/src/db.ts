import fs from "node:fs/promises";

import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { ensureRuntimeDirectories, resolveRuntimePaths, type RuntimePaths } from "./config.js";

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

export const briefsTable = sqliteTable("briefs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  draft: jsonText("draft").notNull(),
  transcript: jsonText("transcript").notNull(),
  githubEpicNumber: integer("github_epic_number"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const epicsTable = sqliteTable("epics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  briefId: integer("brief_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  githubIssueNumber: integer("github_issue_number"),
  childIssueNumbers: jsonText("child_issue_numbers").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const directorTasksTable = sqliteTable("director_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  briefId: integer("brief_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  recommendation: text("recommendation").notNull(),
  status: text("status").notNull(),
  payload: jsonText("payload").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const agentRunsTable = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  role: text("role").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull(),
  inputSummary: text("input_summary").notNull(),
  outputSummary: text("output_summary").notNull(),
  outputJson: jsonText("output_json"),
  workingDirectory: text("working_directory"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

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
  briefsTable,
  epicsTable,
  directorTasksTable,
  agentRunsTable,
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
create table if not exists briefs (
  id integer primary key autoincrement,
  project_id integer not null,
  title text not null,
  status text not null,
  summary text not null,
  draft text not null,
  transcript text not null,
  github_epic_number integer,
  created_at text not null,
  updated_at text not null
);
create table if not exists epics (
  id integer primary key autoincrement,
  project_id integer not null,
  brief_id integer not null,
  title text not null,
  summary text not null,
  status text not null,
  github_issue_number integer,
  child_issue_numbers text not null,
  created_at text not null,
  updated_at text not null
);
create table if not exists director_tasks (
  id integer primary key autoincrement,
  project_id integer not null,
  brief_id integer,
  kind text not null,
  title text not null,
  description text not null,
  recommendation text not null,
  status text not null,
  payload text not null,
  created_at text not null,
  updated_at text not null
);
create table if not exists agent_runs (
  id integer primary key autoincrement,
  project_id integer not null,
  role text not null,
  target_type text not null,
  target_id text not null,
  status text not null,
  input_summary text not null,
  output_summary text not null,
  output_json text,
  working_directory text,
  created_at text not null,
  updated_at text not null
);
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

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.exec(bootstrapSql);
}

export function asJson<TValue>(value: TValue): TValue {
  return value;
}

export function fromJson<TValue>(value: TValue): TValue {
  return value;
}
