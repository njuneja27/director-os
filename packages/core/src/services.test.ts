import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { ProjectRecord } from "@director-os/shared";
import type { StoredProjectConfig } from "./config.js";
import {
  ensureIssueWorktree,
  reconcileProjectConfigWithRepository,
  resolveLastSuccessfulSyncAt
} from "./services.js";

const execFileAsync = promisify(execFile);

function makeProjectConfig(
  overrides: Partial<StoredProjectConfig> = {}
): StoredProjectConfig {
  return {
    id: 1,
    name: "Director OS",
    slug: "director-os",
    repoPath: "/repo",
    repoSlug: "njuneja27/director-os",
    defaultBranch: "main",
    defaultBranchStrategy: null,
    worktreeRoot: "/tmp/director-os",
    agentRunner: "codex",
    createdAt: "2026-04-05T00:00:00.000Z",
    model: "gpt-5.4",
    updatedAt: "2026-04-05T00:00:00.000Z",
    ...overrides
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createTempProjectRecord(): Promise<{
  cleanup: () => Promise<void>;
  project: ProjectRecord;
}> {
  const sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "director-os-worktree-"))
  );
  const repoPath = path.join(sandboxRoot, "repo");
  const worktreeRoot = path.join(sandboxRoot, "worktrees");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });

  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.name", "Codex"]);
  await runGit(repoPath, ["config", "user.email", "codex@example.com"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "Initial commit"]);

  return {
    cleanup: () => fs.rm(sandboxRoot, { recursive: true, force: true }),
    project: {
      id: 1,
      name: "Director OS",
      slug: "director-os",
      repoPath,
      repoSlug: "njuneja27/director-os",
      defaultBranch: "main",
      worktreeRoot,
      agentRunner: "codex",
      model: "gpt-5.4",
      createdAt: "2026-04-05T00:00:00.000Z",
      updatedAt: "2026-04-05T00:00:00.000Z"
    }
  };
}

describe("reconcileProjectConfigWithRepository", () => {
  it("heals a stale base branch when the repo is back on the GitHub default", () => {
    const projectConfig = makeProjectConfig({
      defaultBranch: "codex/issue-53-54-55-routing"
    });

    const reconciled = reconcileProjectConfigWithRepository(projectConfig, {
      repoDefaultBranch: "main",
      currentBranch: "main"
    });

    expect(reconciled.nextProjectConfig.defaultBranch).toBe("main");
    expect(reconciled.changes).toContain(
      "Updated base branch from codex/issue-53-54-55-routing to main."
    );
  });

  it("preserves a custom base branch while working off the GitHub default branch", () => {
    const projectConfig = makeProjectConfig({
      defaultBranch: "codex/issue-53-54-55-routing"
    });

    const reconciled = reconcileProjectConfigWithRepository(projectConfig, {
      repoDefaultBranch: "main",
      currentBranch: "codex/issue-53-54-55-routing"
    });

    expect(reconciled.nextProjectConfig.defaultBranch).toBe(
      "codex/issue-53-54-55-routing"
    );
    expect(reconciled.nextProjectConfig.defaultBranchStrategy).toBe("custom");
    expect(reconciled.changes).toEqual([]);
  });

  it("updates the stored repo slug when GitHub reports a different canonical slug", () => {
    const projectConfig = makeProjectConfig({
      repoSlug: "old/director-os"
    });

    const reconciled = reconcileProjectConfigWithRepository(projectConfig, {
      repoSlug: "njuneja27/director-os",
      repoDefaultBranch: "main",
      currentBranch: "main"
    });

    expect(reconciled.nextProjectConfig.repoSlug).toBe("njuneja27/director-os");
    expect(reconciled.changes).toContain(
      "Updated repo slug from old/director-os to njuneja27/director-os."
    );
  });
});

describe("ensureIssueWorktree", () => {
  it("creates a fresh rerun worktree when a clean issue branch has diverged behind main", async () => {
    const { cleanup, project } = await createTempProjectRecord();
    const issueNumber = 55;
    const branchName = "codex/issue-55-route-all-blocker-handling-through-t";
    const worktreePath = path.join(project.worktreeRoot, `issue-${issueNumber}`);

    try {
      await ensureIssueWorktree(project, issueNumber, branchName, worktreePath);

      await fs.writeFile(path.join(worktreePath, "issue.txt"), "issue work\n", "utf8");
      await runGit(worktreePath, ["add", "issue.txt"]);
      await runGit(worktreePath, ["commit", "-m", "Issue branch commit"]);

      await fs.writeFile(path.join(project.repoPath, "main.txt"), "main update\n", "utf8");
      await runGit(project.repoPath, ["add", "main.txt"]);
      await runGit(project.repoPath, ["commit", "-m", "Main branch commit"]);

      const refreshed = await ensureIssueWorktree(project, issueNumber, branchName, worktreePath);

      expect(refreshed.branchName).toBe(`${branchName}-rerun-1`);
      expect(refreshed.worktreePath).toBe(`${worktreePath}-rerun-1`);
      expect(await runGit(refreshed.worktreePath, ["rev-parse", "HEAD"])).toBe(
        await runGit(project.repoPath, ["rev-parse", "main"])
      );
    } finally {
      await cleanup();
    }
  });

  it("preserves the existing branch when the issue already has an open PR branch to refine", async () => {
    const { cleanup, project } = await createTempProjectRecord();
    const issueNumber = 55;
    const branchName = "codex/issue-55-route-all-blocker-handling-through-t";
    const worktreePath = path.join(project.worktreeRoot, `issue-${issueNumber}`);

    try {
      await ensureIssueWorktree(project, issueNumber, branchName, worktreePath);

      await fs.writeFile(path.join(worktreePath, "issue.txt"), "issue work\n", "utf8");
      await runGit(worktreePath, ["add", "issue.txt"]);
      await runGit(worktreePath, ["commit", "-m", "Issue branch commit"]);

      await fs.writeFile(path.join(project.repoPath, "main.txt"), "main update\n", "utf8");
      await runGit(project.repoPath, ["add", "main.txt"]);
      await runGit(project.repoPath, ["commit", "-m", "Main branch commit"]);

      const preserved = await ensureIssueWorktree(project, issueNumber, branchName, worktreePath, {
        preserveExistingBranch: true
      });

      expect(preserved.branchName).toBe(branchName);
      expect(preserved.worktreePath).toBe(worktreePath);
    } finally {
      await cleanup();
    }
  });
});

describe("resolveLastSuccessfulSyncAt", () => {
  it("falls back to the GitHub cache timestamp when router state has not recorded one yet", () => {
    expect(
      resolveLastSuccessfulSyncAt(null, "2026-04-05T12:00:00.000Z")
    ).toBe("2026-04-05T12:00:00.000Z");
  });

  it("prefers the freshest successful sync timestamp when router and cache values differ", () => {
    expect(
      resolveLastSuccessfulSyncAt(
        "2026-04-05T11:45:00.000Z",
        "2026-04-05T12:00:00.000Z"
      )
    ).toBe("2026-04-05T12:00:00.000Z");
  });

  it("ignores malformed timestamps instead of surfacing an invalid sync time", () => {
    expect(
      resolveLastSuccessfulSyncAt("not-a-timestamp", "2026-04-05T12:00:00.000Z")
    ).toBe("2026-04-05T12:00:00.000Z");
    expect(resolveLastSuccessfulSyncAt("not-a-timestamp", "also-bad")).toBeNull();
  });
});
