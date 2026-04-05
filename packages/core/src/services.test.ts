import { describe, expect, it } from "vitest";

import type { StoredProjectConfig } from "./config.js";
import { reconcileProjectConfigWithRepository } from "./services.js";

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
