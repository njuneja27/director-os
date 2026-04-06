export type GitWorktreeEntry = {
  path: string;
  branchName: string | null;
  isPrunable: boolean;
};

export function parseGitWorktreeList(porcelain: string): GitWorktreeEntry[] {
  return porcelain
    .trim()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let worktreePath: string | null = null;
      let branchName: string | null = null;
      let isPrunable = false;

      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length);
          continue;
        }

        if (line.startsWith("branch ")) {
          const rawBranch = line.slice("branch ".length);
          branchName = rawBranch.startsWith("refs/heads/")
            ? rawBranch.slice("refs/heads/".length)
            : rawBranch;
          continue;
        }

        if (line.startsWith("prunable")) {
          isPrunable = true;
        }
      }

      if (!worktreePath) {
        return null;
      }

      return {
        path: worktreePath,
        branchName,
        isPrunable
      };
    })
    .filter((entry): entry is GitWorktreeEntry => entry !== null);
}

export function selectReusableGitWorktree(
  entries: GitWorktreeEntry[],
  desiredPath: string,
  desiredBranchName: string
): GitWorktreeEntry | null {
  const exactPathMatch =
    entries.find(
      (entry) => entry.path === desiredPath && !entry.isPrunable && Boolean(entry.branchName)
    ) ?? null;

  if (exactPathMatch) {
    return exactPathMatch;
  }

  return (
    entries.find(
      (entry) => entry.branchName === desiredBranchName && !entry.isPrunable && Boolean(entry.branchName)
    ) ?? null
  );
}

export function shouldReuseCleanIssueWorktree(input: {
  branchHeadRevision: string;
  defaultBranchRevision: string;
  branchCommitsBehind: number;
}): boolean {
  return input.branchHeadRevision === input.defaultBranchRevision || input.branchCommitsBehind === 0;
}
