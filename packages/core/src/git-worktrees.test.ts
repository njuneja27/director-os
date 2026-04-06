import { describe, expect, it } from "vitest";

import {
  parseGitWorktreeList,
  selectReusableGitWorktree,
  shouldReuseCleanIssueWorktree
} from "./git-worktrees.js";

describe("parseGitWorktreeList", () => {
  it("parses branch and prunable flags from porcelain output", () => {
    const parsed = parseGitWorktreeList(`
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /tmp/issue-30
HEAD def456
branch refs/heads/codex/issue-30
prunable gitdir file points to non-existent location
`);

    expect(parsed).toEqual([
      {
        path: "/repo",
        branchName: "main",
        isPrunable: false
      },
      {
        path: "/tmp/issue-30",
        branchName: "codex/issue-30",
        isPrunable: true
      }
    ]);
  });
});

describe("selectReusableGitWorktree", () => {
  it("prefers an exact live path match", () => {
    const reusable = selectReusableGitWorktree(
      [
        {
          path: "/tmp/issue-30",
          branchName: "codex/issue-30-old-title",
          isPrunable: false
        },
        {
          path: "/tmp/elsewhere",
          branchName: "codex/issue-30-new-title",
          isPrunable: false
        }
      ],
      "/tmp/issue-30",
      "codex/issue-30-new-title"
    );

    expect(reusable).toEqual({
      path: "/tmp/issue-30",
      branchName: "codex/issue-30-old-title",
      isPrunable: false
    });
  });

  it("falls back to a live branch match when the desired path is unavailable", () => {
    const reusable = selectReusableGitWorktree(
      [
        {
          path: "/tmp/elsewhere",
          branchName: "codex/issue-30",
          isPrunable: false
        },
        {
          path: "/tmp/prunable",
          branchName: "codex/issue-30",
          isPrunable: true
        }
      ],
      "/tmp/issue-30",
      "codex/issue-30"
    );

    expect(reusable).toEqual({
      path: "/tmp/elsewhere",
      branchName: "codex/issue-30",
      isPrunable: false
    });
  });
});

describe("shouldReuseCleanIssueWorktree", () => {
  it("reuses a clean branch when it already matches the current default branch tip", () => {
    expect(
      shouldReuseCleanIssueWorktree({
        branchHeadRevision: "abc123",
        defaultBranchRevision: "abc123",
        branchCommitsBehind: 0
      })
    ).toBe(true);
  });

  it("reuses a clean branch when it still contains the current default branch tip", () => {
    expect(
      shouldReuseCleanIssueWorktree({
        branchHeadRevision: "def456",
        defaultBranchRevision: "abc123",
        branchCommitsBehind: 0
      })
    ).toBe(true);
  });

  it("rejects a clean branch that has fallen behind the current default branch tip", () => {
    expect(
      shouldReuseCleanIssueWorktree({
        branchHeadRevision: "def456",
        defaultBranchRevision: "abc123",
        branchCommitsBehind: 2
      })
    ).toBe(false);
  });
});
