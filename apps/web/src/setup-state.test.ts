import { describe, expect, it } from "vitest";

import type { SetupCheck, SetupStatusResponse } from "./api";
import { deriveSetupStateBadge, hasCompletedSetup } from "./setup-state";

function makeCheck(overrides: Partial<SetupCheck>): SetupCheck {
  return {
    kind: "repository",
    status: "ready",
    title: "Repository",
    detail: "Ready",
    code: null,
    recommendedAction: null,
    advancedDetail: null,
    ...overrides
  };
}

function makeStatus(overrides: Partial<SetupStatusResponse> = {}): SetupStatusResponse {
  return {
    activeProject: null,
    hasCompletedSetup: false,
    checks: [],
    repositoryDraft: null,
    canComplete: false,
    completed: false,
    ...overrides
  };
}

describe("hasCompletedSetup", () => {
  it("treats a registered project as the durable setup-complete boundary", () => {
    expect(
      hasCompletedSetup(
        makeStatus({
          hasCompletedSetup: true,
          completed: false
        })
      )
    ).toBe(true);
  });
});

describe("deriveSetupStateBadge", () => {
  it("shows a control-room-ready badge when setup is complete and healthy", () => {
    expect(
      deriveSetupStateBadge(
        makeStatus({
          hasCompletedSetup: true,
          completed: true
        })
      )
    ).toEqual({
      className: "engine-badge-ready",
      label: "Control room ready"
    });
  });

  it("surfaces repair state instead of setup pending once a project is registered", () => {
    expect(
      deriveSetupStateBadge(
        makeStatus({
          hasCompletedSetup: true,
          completed: false,
          checks: [
            makeCheck({
              kind: "workspace",
              status: "blocked",
              code: "workspace_probe_failed",
              detail: "Worktree check failed."
            })
          ]
        })
      )
    ).toEqual({
      className: "engine-badge-danger",
      label: "Repair required"
    });
  });

  it("keeps incomplete setup in a pending state until the project is registered", () => {
    expect(
      deriveSetupStateBadge(
        makeStatus({
          checks: [
            makeCheck({
              kind: "repository",
              status: "needs_action",
              code: "repo_missing",
              detail: "Choose a Git repository."
            })
          ]
        })
      )
    ).toEqual({
      className: "engine-badge-warning",
      label: "Setup pending"
    });
  });
});
