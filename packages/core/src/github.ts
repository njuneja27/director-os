import fs from "node:fs/promises";
import path from "node:path";
import { basename } from "node:path";

import {
  commandErrorText,
  isMissingBinaryError,
  runCommandCapture,
  type CommandRunner
} from "./commands.js";

export interface RepoDetails {
  repoSlug: string;
  defaultBranch: string;
  name: string;
}

export interface CliProbeResult {
  ok: boolean;
  reason: "ready" | "missing" | "auth_required" | "error";
  detail: string;
  advancedDetail?: string;
}

export interface RepositoryProbeResult extends RepoDetails {
  repoPath: string;
}

export interface RemoteIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface RemotePullRequest {
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
}

export interface RemoteComment {
  githubId: string;
  parentType: "issue" | "pr";
  parentNumber: number;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestView extends RemotePullRequest {}

export interface PullRequestCheck {
  bucket: string;
  name: string;
  state: string;
  workflow: string | null;
  link: string | null;
}

type RepoViewPayload = {
  name: string;
  nameWithOwner: string;
  defaultBranchRef: {
    name: string;
  };
};

type IssueApiPayload = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels?: Array<{ name?: string }>;
  pull_request?: Record<string, unknown>;
};

type PullRequestPayload = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  statusCheckRollup?: Array<{ conclusion?: string | null; state?: string | null }>;
  closingIssuesReferences?: Array<{ number: number }>;
};

type IssueCommentPayload = {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: {
    login?: string;
  };
  issue_url: string;
};

type ReviewCommentPayload = {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: {
    login?: string;
  };
  pull_request_url: string;
};

async function runGh(
  args: string[],
  options?: {
    cwd?: string;
    runner?: CommandRunner;
  }
): Promise<string> {
  const result = await (options?.runner ?? runCommandCapture)("gh", args, {
    cwd: options?.cwd,
    maxBuffer: 20 * 1024 * 1024
  });

  return result.stdout;
}

function parseRepoSlugFromRemote(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim();

  const httpsMatch = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(normalized);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(normalized);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  return null;
}

async function gitOutput(
  repoPath: string,
  args: string[],
  runner: CommandRunner = runCommandCapture
): Promise<string> {
  const result = await runner("git", args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024
  });

  return result.stdout.trim();
}

async function inferDefaultBranch(
  repoPath: string,
  runner: CommandRunner = runCommandCapture
): Promise<string | null> {
  try {
    const remoteHead = await gitOutput(
      repoPath,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      runner
    );
    const parts = remoteHead.split("/");
    return parts.at(-1) ?? null;
  } catch {
    try {
      const branch = await gitOutput(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], runner);
      return branch === "HEAD" ? null : branch;
    } catch {
      return null;
    }
  }
}

export async function probeGhCli(runner: CommandRunner = runCommandCapture): Promise<CliProbeResult> {
  try {
    await runner("gh", ["auth", "status"], {
      maxBuffer: 20 * 1024 * 1024
    });

    return {
      ok: true,
      reason: "ready",
      detail: "GitHub CLI is installed and authenticated."
    };
  } catch (error) {
    const detail = commandErrorText(error);

    if (isMissingBinaryError(error)) {
      return {
        ok: false,
        reason: "missing",
        detail: "GitHub CLI was not found on this machine.",
        advancedDetail: detail || "Command checked: gh auth status"
      };
    }

    if (/not logged into/i.test(detail) || /authenticate/i.test(detail)) {
      return {
        ok: false,
        reason: "auth_required",
        detail: "GitHub CLI is installed, but sign-in is required.",
        advancedDetail: detail
      };
    }

    return {
      ok: false,
      reason: "error",
      detail: "GitHub CLI could not be verified.",
      advancedDetail: detail
    };
  }
}

export async function probeRepositoryPath(
  repoPath: string,
  runner: CommandRunner = runCommandCapture
): Promise<RepositoryProbeResult> {
  const absolutePath = path.resolve(repoPath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isDirectory()) {
    throw new Error(`${absolutePath} is not a directory.`);
  }

  await gitOutput(absolutePath, ["rev-parse", "--is-inside-work-tree"], runner);

  const remoteUrl = await gitOutput(absolutePath, ["remote", "get-url", "origin"], runner);
  const repoSlug = parseRepoSlugFromRemote(remoteUrl);
  const defaultBranch = await inferDefaultBranch(absolutePath, runner);
  const repoName = repoSlug ? basename(repoSlug) : basename(absolutePath);

  return {
    repoPath: absolutePath,
    repoSlug: repoSlug ?? "",
    defaultBranch: defaultBranch ?? "",
    name: repoName
  };
}

export async function ensureGhAuthenticated(): Promise<void> {
  await runGh(["auth", "status"]);
}

export async function detectRepoFromPath(repoPath: string): Promise<RepoDetails> {
  const stdout = await runGh(
    ["repo", "view", "--json", "name,nameWithOwner,defaultBranchRef"],
    { cwd: repoPath }
  );
  const payload = JSON.parse(stdout) as RepoViewPayload;

  return {
    repoSlug: payload.nameWithOwner,
    defaultBranch: payload.defaultBranchRef.name,
    name: payload.name
  };
}

export async function fetchRepoDetails(repoSlug: string): Promise<RepoDetails> {
  const stdout = await runGh([
    "repo",
    "view",
    repoSlug,
    "--json",
    "name,nameWithOwner,defaultBranchRef"
  ]);
  const payload = JSON.parse(stdout) as RepoViewPayload;

  return {
    repoSlug: payload.nameWithOwner,
    defaultBranch: payload.defaultBranchRef.name,
    name: payload.name
  };
}

export async function listIssues(repoSlug: string): Promise<RemoteIssue[]> {
  const stdout = await runGh([
    "api",
    `repos/${repoSlug}/issues?state=all&per_page=100`
  ]);
  const payload = JSON.parse(stdout) as IssueApiPayload[];

  return payload
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      state: item.state,
      labels: Array.isArray(item.labels)
        ? item.labels.flatMap((label) => (label.name ? [label.name] : []))
        : [],
      url: item.html_url,
      updatedAt: item.updated_at
    }));
}

function bucketFromRollup(rollup: PullRequestPayload["statusCheckRollup"]): string | null {
  if (!rollup || rollup.length === 0) {
    return null;
  }

  const states = rollup.map((item) => item.conclusion ?? item.state ?? "UNKNOWN");

  if (states.some((state) => ["FAILURE", "FAILED", "ERROR", "STARTUP_FAILURE"].includes(state))) {
    return "fail";
  }

  if (states.some((state) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(state))) {
    return "pending";
  }

  if (states.every((state) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state))) {
    return "pass";
  }

  return "pending";
}

export async function listPullRequests(repoSlug: string): Promise<RemotePullRequest[]> {
  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "number,title,body,state,isDraft,reviewDecision,headRefName,baseRefName,url,updatedAt,statusCheckRollup,closingIssuesReferences"
  ]);
  const payload = JSON.parse(stdout) as PullRequestPayload[];

  return payload.map((item) => ({
    number: item.number,
    title: item.title,
    body: item.body ?? "",
    state: item.state,
    isDraft: item.isDraft,
    reviewDecision: item.reviewDecision,
    checksBucket: bucketFromRollup(item.statusCheckRollup),
    headRefName: item.headRefName,
    baseRefName: item.baseRefName,
    url: item.url,
    linkedIssueNumbers: Array.isArray(item.closingIssuesReferences)
      ? item.closingIssuesReferences.map((entry) => entry.number)
      : [],
    updatedAt: item.updatedAt
  }));
}

function parseTrailingNumber(value: string): number {
  const match = /\/(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Could not parse item number from ${value}`);
  }

  return Number(match[1]);
}

export async function listComments(repoSlug: string): Promise<RemoteComment[]> {
  const [issueCommentsRaw, reviewCommentsRaw] = await Promise.all([
    runGh(["api", `repos/${repoSlug}/issues/comments?per_page=100&sort=updated&direction=desc`]),
    runGh(["api", `repos/${repoSlug}/pulls/comments?per_page=100&sort=updated&direction=desc`])
  ]);

  const issueComments = (JSON.parse(issueCommentsRaw) as IssueCommentPayload[]).map((item) => ({
    githubId: String(item.id),
    parentType: "issue" as const,
    parentNumber: parseTrailingNumber(item.issue_url),
    author: item.user?.login ?? "unknown",
    body: item.body ?? "",
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  }));

  const reviewComments = (JSON.parse(reviewCommentsRaw) as ReviewCommentPayload[]).map((item) => ({
    githubId: String(item.id),
    parentType: "pr" as const,
    parentNumber: parseTrailingNumber(item.pull_request_url),
    author: item.user?.login ?? "unknown",
    body: item.body ?? "",
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  }));

  return [...issueComments, ...reviewComments];
}

export async function createIssue(
  repoSlug: string,
  input: {
    title: string;
    body: string;
    labels?: string[];
  }
): Promise<{ number: number; url: string }> {
  const args = ["api", "--method", "POST", `repos/${repoSlug}/issues`, "-f", `title=${input.title}`, "-f", `body=${input.body}`];

  for (const label of input.labels ?? []) {
    args.push("-f", `labels[]=${label}`);
  }

  const stdout = await runGh(args);
  const payload = JSON.parse(stdout) as { number: number; html_url: string };

  return {
    number: payload.number,
    url: payload.html_url
  };
}

export async function addIssueLabels(repoSlug: string, issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.length) {
    return;
  }

  await runGh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repoSlug,
    "--add-label",
    labels.join(",")
  ]);
}

export async function removeIssueLabels(repoSlug: string, issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.length) {
    return;
  }

  await runGh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repoSlug,
    "--remove-label",
    labels.join(",")
  ]);
}

export async function commentOnIssue(repoSlug: string, issueNumber: number, body: string): Promise<void> {
  await runGh([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repoSlug,
    "--body",
    body
  ]);
}

export async function commentOnPr(repoPath: string, prNumber: number, body: string): Promise<void> {
  await runGh([
    "pr",
    "comment",
    String(prNumber),
    "--body",
    body
  ], { cwd: repoPath });
}

export async function createPullRequest(
  repoPath: string,
  input: {
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  }
): Promise<{ number: number; url: string }> {
  const stdout = await runGh([
    "pr",
    "create",
    "--base",
    input.baseBranch,
    "--head",
    input.headBranch,
    "--title",
    input.title,
    "--body",
    input.body
  ], { cwd: repoPath });

  const url = stdout.split("\n").filter(Boolean).at(-1) ?? stdout;
  const number = parseTrailingNumber(url);

  return {
    number,
    url
  };
}

export async function viewPullRequest(repoPath: string, prNumber: number): Promise<PullRequestView> {
  const stdout = await runGh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,body,state,isDraft,reviewDecision,headRefName,baseRefName,url,updatedAt,statusCheckRollup,closingIssuesReferences"
  ], { cwd: repoPath });

  const item = JSON.parse(stdout) as PullRequestPayload;

  return {
    number: item.number,
    title: item.title,
    body: item.body ?? "",
    state: item.state,
    isDraft: item.isDraft,
    reviewDecision: item.reviewDecision,
    checksBucket: bucketFromRollup(item.statusCheckRollup),
    headRefName: item.headRefName,
    baseRefName: item.baseRefName,
    url: item.url,
    linkedIssueNumbers: Array.isArray(item.closingIssuesReferences)
      ? item.closingIssuesReferences.map((entry) => entry.number)
      : [],
    updatedAt: item.updatedAt
  };
}

export async function pullRequestDiff(repoPath: string, prNumber: number): Promise<string> {
  return runGh(["pr", "diff", String(prNumber)], { cwd: repoPath });
}

export async function pullRequestChecks(repoPath: string, prNumber: number): Promise<PullRequestCheck[]> {
  const stdout = await runGh([
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "bucket,name,state,workflow,link"
  ], { cwd: repoPath });

  return JSON.parse(stdout) as PullRequestCheck[];
}

export async function mergePullRequest(repoPath: string, prNumber: number): Promise<void> {
  await runGh([
    "pr",
    "merge",
    String(prNumber),
    "--squash",
    "--delete-branch"
  ], { cwd: repoPath });
}

export function resolveRepoPath(repoPath: string): string {
  return path.resolve(repoPath);
}
