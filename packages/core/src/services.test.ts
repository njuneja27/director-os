import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type {
  DecisionRecord,
  GitHubIssueRecord,
  ProjectRecord,
  RunRecord
} from "@director-os/shared";
import type { StoredProjectConfig } from "./config.js";
import { createDefaultRouterState, type RouterState } from "./runtime-state.js";
import {
  buildChiefOfStaffBlockerLaneResult,
  buildPrSweepBlockerLabels,
  buildResetRouterState,
  buildSyntheticIssueRecord,
  ensureIssueWorktree,
  isPrSweepDue,
  preferredLaneForIssue,
  queueChiefOfStaffReviewFromLaneState,
  reassignIssueLaneInRouter,
  reconcileProjectConfigWithRepository,
  resolveLastSuccessfulSyncAt,
  schedulePrSweepState,
  sortQueueableIssues,
  startPrSweepState,
  synthesizeLaneSuggestions,
  synthesizeProjectConfigStatus,
  updateRunningPrSweepState
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

function makeProjectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 1,
    name: "Director OS",
    slug: "director-os",
    repoPath: "/repo",
    repoSlug: "njuneja27/director-os",
    defaultBranch: "main",
    worktreeRoot: "/tmp/director-os",
    agentRunner: "codex",
    model: "gpt-5.4",
    createdAt: "2026-04-05T00:00:00.000Z",
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

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 1,
    projectId: 1,
    issueNumber: 53,
    prNumber: null,
    role: "chief_of_staff",
    status: "succeeded",
    phase: "queue_review",
    summary: "Routed issue #53.",
    recommendedNextAction: "Continue with implementation.",
    artifacts: [],
    blockingQuestions: [],
    outputJson: null,
    rawModelOutput: null,
    worktreePath: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...overrides
  };
}

function makeDecisionRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 1,
    projectId: 1,
    issueNumber: 53,
    prNumber: null,
    requestedByRunId: 1,
    questionMessageId: null,
    resolutionMessageId: null,
    target: "human_director",
    title: "Chief of Staff question for #53",
    summary: "Need a product decision.",
    recommendation: "Reply with the preferred routing direction.",
    rationale: "The Chief of Staff could not safely decide.",
    status: "open",
    resolution: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...overrides
  };
}

function makeIssueRecord(
  number: number,
  overrides: Partial<GitHubIssueRecord> = {}
): GitHubIssueRecord {
  return {
    id: number,
    projectId: 1,
    number,
    title: `Issue #${number}`,
    body: "",
    state: "open",
    workflowState: "ready",
    labels: [],
    url: `https://github.com/njuneja27/director-os/issues/${number}`,
    updatedAt: "2026-04-06T00:00:00.000Z",
    syncedAt: "2026-04-06T00:00:00.000Z",
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

describe("synthesizeProjectConfigStatus", () => {
  it("reports a healthy repo-default target when the stored and detected defaults match", () => {
    const status = synthesizeProjectConfigStatus(makeProjectConfig(), {
      repoDefaultBranch: "main",
      currentBranch: "main"
    });

    expect(status).toEqual({
      defaultBranchStrategy: "repo_default",
      repoDefaultBranch: "main",
      currentBranch: "main",
      branchStatus: "healthy",
      branchStatusSummary: "Targeting repo default branch main.",
      canHealToRepoDefault: false
    });
  });

  it("flags stale repo-default targets and exposes a recovery action", () => {
    const status = synthesizeProjectConfigStatus(
      makeProjectConfig({
        defaultBranch: "codex/issue-53-54-55-routing"
      }),
      {
        repoDefaultBranch: "main",
        currentBranch: "main"
      }
    );

    expect(status.defaultBranchStrategy).toBe("repo_default");
    expect(status.branchStatus).toBe("stale");
    expect(status.repoDefaultBranch).toBe("main");
    expect(status.currentBranch).toBe("main");
    expect(status.canHealToRepoDefault).toBe(true);
    expect(status.branchStatusSummary).toContain("stale");
    expect(status.branchStatusSummary).toContain("main");
  });

  it("surfaces custom targets without offering repo-default healing", () => {
    const status = synthesizeProjectConfigStatus(
      makeProjectConfig({
        defaultBranch: "release/preview",
        defaultBranchStrategy: "custom"
      }),
      {
        repoDefaultBranch: "main",
        currentBranch: "release/preview"
      }
    );

    expect(status).toEqual({
      defaultBranchStrategy: "custom",
      repoDefaultBranch: "main",
      currentBranch: "release/preview",
      branchStatus: "custom",
      branchStatusSummary: "Targeting custom base branch release/preview instead of repo default main.",
      canHealToRepoDefault: false
    });
  });

  it("falls back to unknown when the local repo default cannot be detected", () => {
    const status = synthesizeProjectConfigStatus(makeProjectConfig(), {
      repoDefaultBranch: null,
      currentBranch: "main"
    });

    expect(status).toEqual({
      defaultBranchStrategy: "repo_default",
      repoDefaultBranch: null,
      currentBranch: "main",
      branchStatus: "unknown",
      branchStatusSummary:
        "Targeting base branch main, but the local repo default branch could not be detected yet.",
      canHealToRepoDefault: false
    });
  });
});

describe("lane assignment helpers", () => {
  it("distinguishes explicit lane labels from the default fallback lane", () => {
    expect(
      preferredLaneForIssue(
        makeIssueRecord(89, {
          labels: ["director:lane:experience"]
        })
      )
    ).toEqual({
      id: "experience",
      name: "Experience",
      source: "explicit"
    });

    expect(preferredLaneForIssue(makeIssueRecord(30))).toEqual({
      id: "delivery",
      name: "Delivery",
      source: "fallback"
    });
  });

  it("builds lane suggestions from active lanes and open issue preferences", () => {
    const suggestions = synthesizeLaneSuggestions(
      [
        makeIssueRecord(30),
        makeIssueRecord(36, {
          labels: ["director:lane:experience"]
        }),
        makeIssueRecord(79, {
          labels: ["director:lane:experience"]
        })
      ],
      [
        {
          id: "delivery",
          name: "Delivery",
          sessionId: "lane-delivery",
          issueNumbers: [30],
          status: "implementing",
          currentIssueNumber: 30,
          activePullRequestNumber: null,
          lastSummary: "Working issue #30.",
          lastPlanSummary: null,
          updatedAt: "2026-04-06T00:00:00.000Z"
        }
      ]
    );

    expect(suggestions).toEqual([
      {
        id: "delivery",
        name: "Delivery",
        isActive: true,
        issueCount: 1
      },
      {
        id: "experience",
        name: "Experience",
        isActive: false,
        issueCount: 2
      }
    ]);
  });

  it("reassigns active lane ownership and pending handoffs together", () => {
    const router: RouterState = {
      ...createDefaultRouterState("director-os"),
      lanes: [
        {
          id: "delivery",
          name: "Delivery",
          sessionId: "lane-delivery",
          issueNumbers: [79],
          status: "implementing",
          currentIssueNumber: 79,
          activePullRequestNumber: null,
          lastSummary: "Implementing issue #79.",
          lastPlanSummary: null,
          updatedAt: "2026-04-06T00:00:00.000Z"
        }
      ],
      issueOwnership: {
        "79": "delivery"
      },
      pendingHandoffs: [
        {
          id: "handoff_79",
          laneId: "delivery",
          issueNumber: 79,
          kind: "implement",
          status: "pending",
          summary: "Implement issue #79.",
          prNumber: null,
          branchName: "codex/issue-79-parallel-lanes",
          worktreePath: "/tmp/director-os/worktrees/issue-79",
          startedAt: null,
          startedBy: null,
          startedByPid: null,
          reviewWindowEndsAt: null,
          lastHandledCommentAt: null,
          details: null,
          createdAt: "2026-04-06T00:00:00.000Z",
          updatedAt: "2026-04-06T00:00:00.000Z"
        }
      ]
    };

    const lane = reassignIssueLaneInRouter(router, 79, "experience", "Experience");

    expect(lane.id).toBe("experience");
    expect(lane.name).toBe("Experience");
    expect(lane.status).toBe("implementing");
    expect(router.issueOwnership["79"]).toBe("experience");
    expect(router.lanes.find((candidate) => candidate.id === "delivery")?.issueNumbers).toEqual([]);
    expect(router.lanes.find((candidate) => candidate.id === "experience")?.issueNumbers).toEqual([79]);
    expect(router.pendingHandoffs[0]?.laneId).toBe("experience");
  });
});

describe("issue-centric shared contracts", () => {
  it("allows run and decision records without work-item ids", () => {
    const run = makeRunRecord();
    const decision = makeDecisionRecord();

    expect(run.issueNumber).toBe(53);
    expect(decision.issueNumber).toBe(53);
    expect("workItemId" in run).toBe(false);
    expect("workItemId" in decision).toBe(false);
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

describe("PR sweep helpers", () => {
  it("prioritizes blocker issues ahead of the normal issue queue", () => {
    const ordered = sortQueueableIssues([
      makeIssueRecord(40, {
        workflowState: "queued"
      }),
      makeIssueRecord(10, {
        workflowState: "queued",
        labels: ["director:priority"]
      }),
      makeIssueRecord(20),
      makeIssueRecord(30, {
        labels: ["director:priority"]
      })
    ]);

    expect(ordered.map((issue) => issue.number)).toEqual([30, 10, 20, 40]);
  });

  it("schedules the next PR sweep and preserves blocker visibility", () => {
    const nowMs = Date.parse("2026-04-06T14:00:00.000Z");
    const state = schedulePrSweepState(
      {
        ...createDefaultRouterState("director-os").prSweep,
        blockerIssueNumbers: [98]
      },
      2,
      "Next PR sweep scheduled.",
      nowMs
    );

    expect(state.status).toBe("scheduled");
    expect(state.nextRunAt).toBe("2026-04-06T16:00:00.000Z");
    expect(state.waitingOnIssueNumber).toBe(98);
    expect(state.pausedIssueWork).toBe(false);
    expect(state.pendingPullRequestNumbers).toEqual([]);
    expect(state.lastSummary).toBe("Next PR sweep scheduled.");
  });

  it("marks sweep runs as active and steps pending PRs down as each review starts", () => {
    const started = startPrSweepState(createDefaultRouterState("director-os").prSweep, [83, 84, 85], {
      now: "2026-04-06T14:05:00.000Z"
    });
    const updated = updateRunningPrSweepState(started, {
      currentPullRequestNumber: 83,
      removePullRequestNumber: 83,
      blockerIssueNumber: 112,
      waitingOnIssueNumber: 112,
      summary: "Opened blocker issue #112 while reviewing PR #83.",
      now: "2026-04-06T14:06:00.000Z"
    });

    expect(started.status).toBe("running");
    expect(started.pendingPullRequestNumbers).toEqual([83, 84, 85]);
    expect(started.pausedIssueWork).toBe(true);
    expect(updated.currentPullRequestNumber).toBe(83);
    expect(updated.pendingPullRequestNumbers).toEqual([84, 85]);
    expect(updated.blockerIssueNumbers).toEqual([112]);
    expect(updated.waitingOnIssueNumber).toBe(112);
    expect(updated.lastSummary).toBe("Opened blocker issue #112 while reviewing PR #83.");
  });

  it("treats running sweeps and overdue scheduled sweeps as immediately due", () => {
    const nowMs = Date.parse("2026-04-06T14:00:00.000Z");

    expect(
      isPrSweepDue(
        {
          status: "running",
          nextRunAt: null
        },
        nowMs
      )
    ).toBe(true);

    expect(
      isPrSweepDue(
        {
          status: "scheduled",
          nextRunAt: "2026-04-06T13:59:00.000Z"
        },
        nowMs
      )
    ).toBe(true);

    expect(
      isPrSweepDue(
        {
          status: "scheduled",
          nextRunAt: "2026-04-06T14:01:00.000Z"
        },
        nowMs
      )
    ).toBe(false);
  });

  it("labels PR sweep blocker issues for priority routing and lane ownership", () => {
    expect(buildPrSweepBlockerLabels("experience")).toEqual([
      "director:ready",
      "director:priority",
      "director:lane:experience"
    ]);
    expect(buildPrSweepBlockerLabels("")).toEqual([
      "director:ready",
      "director:priority"
    ]);
  });
});

describe("Chief of Staff blocker routing", () => {
  it("builds a synthetic issue record when lane blocker review cannot rely on cached issue details", () => {
    const issue = buildSyntheticIssueRecord(
      {
        id: 1,
        repoSlug: "njuneja27/director-os"
      },
      55,
      {
        title: "Issue #55 (missing from local cache)",
        body: "The issue was not present in the local GitHub mirror."
      }
    );

    expect(issue.number).toBe(55);
    expect(issue.title).toBe("Issue #55 (missing from local cache)");
    expect(issue.body).toContain("not present in the local GitHub mirror");
    expect(issue.url).toBe("https://github.com/njuneja27/director-os/issues/55");
  });

  it("builds a Chief of Staff blocker lane result that preserves artifacts and records the blocker", () => {
    const result = buildChiefOfStaffBlockerLaneResult({
      summary: "Validation failed.",
      blockingQuestion: "How should the lane recover from this validation failure?",
      transcriptReply: "Delivery hit a validation failure on issue #55.",
      artifactRefs: ["/tmp/director-os/issue-55"],
      commandError: "tsc failed",
      blockerSource: "validation_failure",
      blockerContext: "Validation failed."
    });

    expect(result.status).toBe("needs_input");
    expect(result.artifact_refs).toEqual(["/tmp/director-os/issue-55"]);
    expect(result.blocking_questions).toEqual([
      "How should the lane recover from this validation failure?"
    ]);
    expect(result.data?.transcript_reply).toBe(
      "Delivery hit a validation failure on issue #55."
    );
    expect(result.data?.command_error).toBe("tsc failed");
    expect(result.data?.blocker_source).toBe("validation_failure");
    expect(result.data?.blocker_context).toBe("Validation failed.");
  });

  it("queues lane blockers for Chief of Staff mediation instead of finalizing them directly", () => {
    const session = {
      paths: {
        homeDir: "/tmp/director-os",
        configPath: "/tmp/director-os/config.json",
        runtimeDir: "/tmp/director-os/runtime",
        logsDir: "/tmp/director-os/logs",
        worktreesDir: "/tmp/director-os/worktrees",
        tmpDir: "/tmp/director-os/tmp",
        orchestratorLockPath: "/tmp/director-os/orchestrator.lock.json"
      },
      config: {
        version: 1,
        activeProjectSlug: "director-os",
        projects: [makeProjectConfig()],
        updatedAt: "2026-04-06T00:00:00.000Z"
      },
      project: makeProjectRecord(),
      projectConfig: makeProjectConfig()
    } satisfies Parameters<typeof queueChiefOfStaffReviewFromLaneState>[0];
    const issue = makeIssueRecord(55);
    const router: RouterState = {
      ...createDefaultRouterState("director-os"),
      lanes: [
        {
          id: "delivery",
          name: "Delivery",
          sessionId: "lane-session",
          issueNumbers: [55],
          status: "implementing",
          currentIssueNumber: 55,
          activePullRequestNumber: null,
          lastSummary: "Implementing issue #55.",
          lastPlanSummary: null,
          updatedAt: "2026-04-06T00:00:00.000Z"
        }
      ],
      issueOwnership: {
        "55": "delivery"
      },
      pendingHandoffs: [
        {
          id: "handoff_55",
          laneId: "delivery",
          issueNumber: 55,
          kind: "implement",
          status: "in_progress",
          summary: "Implement issue #55.",
          prNumber: null,
          branchName: "codex/issue-55-chief-of-staff-blockers",
          worktreePath: "/tmp/director-os/worktrees/issue-55",
          startedAt: "2026-04-06T00:01:00.000Z",
          startedBy: "owner-token",
          startedByPid: 1234,
          reviewWindowEndsAt: null,
          lastHandledCommentAt: null,
          details: null,
          createdAt: "2026-04-06T00:00:30.000Z",
          updatedAt: "2026-04-06T00:01:00.000Z"
        }
      ]
    };

    const nextRouter = queueChiefOfStaffReviewFromLaneState(
      session,
      router,
      "handoff_55",
      {
        issue,
        sessionId: "lane-session",
        laneResult: buildChiefOfStaffBlockerLaneResult({
          summary: "Validation failed for issue #55.",
          blockingQuestion: "How should Delivery recover from this validation failure?",
          transcriptReply: "Delivery hit a validation failure on issue #55.",
          artifactRefs: ["/tmp/director-os/worktrees/issue-55"],
          commandError: "tsc failed",
          blockerSource: "validation_failure",
          blockerContext: "Validation failed for issue #55."
        }),
        reviewType: "blocker_mediation",
        branchName: "codex/issue-55-chief-of-staff-blockers",
        worktreePath: "/tmp/director-os/worktrees/issue-55"
      }
    );

    expect(nextRouter).not.toBeNull();
    const completedHandoff = nextRouter?.pendingHandoffs.find(
      (handoff) => handoff.id === "handoff_55"
    );
    const reviewHandoff = nextRouter?.pendingHandoffs.find(
      (handoff) => handoff.kind === "review"
    );
    const deliveryLane = nextRouter?.lanes.find((lane) => lane.id === "delivery");

    expect(completedHandoff?.status).toBe("completed");
    expect(reviewHandoff?.status).toBe("pending");
    expect(reviewHandoff?.details?.review_type).toBe("blocker_mediation");
    expect(deliveryLane?.status).toBe("blocked");
    expect(deliveryLane?.lastSummary).toBe(
      "Delivery hit a validation failure on issue #55."
    );
    expect(nextRouter?.openQuestion).toBeNull();
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

describe("buildResetRouterState", () => {
  it("clears operational router runtime state while preserving sync metadata", () => {
    const router: RouterState = {
      ...createDefaultRouterState("director-os"),
      orchestrator: {
        status: "blocked",
        pauseReason: "Wedged local state",
        lastLoopAt: "2026-04-06T12:30:00.000Z",
        lastSummary: "Router wedged on a pending lane handoff."
      },
      chiefOfStaff: {
        sessionId: "cos-session",
        lastSummary: "Reviewing blocker state.",
        updatedAt: "2026-04-06T12:29:00.000Z"
      },
      lanes: [
        {
          id: "operations",
          name: "Operations",
          sessionId: "lane-session",
          issueNumbers: [82],
          status: "blocked",
          currentIssueNumber: 82,
          activePullRequestNumber: 14,
          lastSummary: "Waiting on a blocker reset.",
          lastPlanSummary: "Reset runtime through the control room.",
          updatedAt: "2026-04-06T12:28:00.000Z"
        }
      ],
      issueOwnership: {
        "82": "operations"
      },
      pendingHandoffs: [
        {
          id: "handoff_1",
          laneId: "operations",
          issueNumber: 82,
          kind: "implement",
          status: "blocked",
          summary: "Lane runtime wedged.",
          prNumber: 14,
          branchName: "codex/issue-82-add-a-control-room-action-to-reset-l",
          worktreePath: "/tmp/director-os/issue-82",
          startedAt: "2026-04-06T12:26:00.000Z",
          startedBy: "owner-token",
          startedByPid: 12345,
          reviewWindowEndsAt: null,
          lastHandledCommentAt: null,
          details: {
            retryable: true
          },
          createdAt: "2026-04-06T12:25:00.000Z",
          updatedAt: "2026-04-06T12:27:00.000Z"
        }
      ],
      prSweep: {
        status: "running",
        nextRunAt: "2026-04-06T12:35:00.000Z",
        currentPullRequestNumber: 95,
        pendingPullRequestNumbers: [96],
        blockerIssueNumbers: [82],
        waitingOnIssueNumber: 82,
        startedAt: "2026-04-06T12:21:00.000Z",
        completedAt: "2026-04-06T11:40:00.000Z",
        lastSummary: "PR sweep is waiting on issue #82 before it resumes backlog work.",
        pausedIssueWork: true,
        updatedAt: "2026-04-06T12:29:30.000Z"
      },
      openQuestion: {
        id: "question_1",
        title: "Need runtime recovery decision",
        summary: "The router is wedged.",
        question: "Should the local router runtime be reset?",
        whyItMatters: "The control room cannot continue until operational state is cleared.",
        recommendation: "Reset the local router runtime from the control room.",
        issueNumber: 82,
        prNumber: 14,
        runId: 9,
        requestedBy: "chief_of_staff",
        createdAt: "2026-04-06T12:24:00.000Z",
        updatedAt: "2026-04-06T12:24:00.000Z"
      },
      recentRuns: [
        {
          id: 9,
          projectId: 1,
          issueNumber: 82,
          prNumber: 14,
          role: "chief_of_staff",
          status: "needs_input",
          phase: "question",
          summary: "Waiting on a runtime recovery decision.",
          recommendedNextAction: "Reset the local router runtime.",
          artifacts: [],
          blockingQuestions: [
            "Should the local router runtime be reset?"
          ],
          outputJson: null,
          rawModelOutput: null,
          worktreePath: null,
          createdAt: "2026-04-06T12:24:00.000Z",
          updatedAt: "2026-04-06T12:24:00.000Z"
        }
      ],
      lastSyncAt: "2026-04-06T12:20:00.000Z",
      updatedAt: "2026-04-06T12:30:00.000Z"
    };

    const reset = buildResetRouterState(router);

    expect(reset.projectSlug).toBe("director-os");
    expect(reset.lastSyncAt).toBe("2026-04-06T12:20:00.000Z");
    expect(reset.orchestrator.status).toBe("idle");
    expect(reset.orchestrator.pauseReason).toBeNull();
    expect(reset.orchestrator.lastLoopAt).toBeNull();
    expect(reset.orchestrator.lastSummary).toContain("reset");
    expect(reset.chiefOfStaff).toEqual({
      sessionId: null,
      lastSummary: null,
      updatedAt: null
    });
    expect(reset.lanes).toEqual([]);
    expect(reset.issueOwnership).toEqual({});
    expect(reset.pendingHandoffs).toEqual([]);
    expect(reset.prSweep.status).toBe("idle");
    expect(reset.prSweep.nextRunAt).toBeNull();
    expect(reset.prSweep.currentPullRequestNumber).toBeNull();
    expect(reset.prSweep.pendingPullRequestNumbers).toEqual([]);
    expect(reset.prSweep.blockerIssueNumbers).toEqual([]);
    expect(reset.prSweep.waitingOnIssueNumber).toBeNull();
    expect(reset.prSweep.pausedIssueWork).toBe(false);
    expect(reset.openQuestion).toBeNull();
    expect(reset.recentRuns).toEqual([]);
  });
});
