import { describe, expect, it } from "vitest";

import type { WorkItemRecord } from "@director-os/shared";

import {
  inferWorkItemStatus,
  selectActiveWorkItems,
  selectQueuedWorkItems
} from "./work-items.js";

function makeWorkItem(overrides: Partial<WorkItemRecord>): WorkItemRecord {
  return {
    id: overrides.id ?? 1,
    projectId: overrides.projectId ?? 1,
    issueNumber: overrides.issueNumber ?? 1,
    parentIssueNumber: overrides.parentIssueNumber ?? null,
    title: overrides.title ?? "Example issue",
    summary: overrides.summary ?? "Example summary",
    kind: overrides.kind ?? "task",
    executionMode: overrides.executionMode ?? "worker",
    ownerRole: overrides.ownerRole ?? "worker",
    status: overrides.status ?? "queued",
    priorityBucket: overrides.priorityBucket ?? 2,
    activeRunId: overrides.activeRunId ?? null,
    activePrNumber: overrides.activePrNumber ?? null,
    lastSummary: overrides.lastSummary ?? null,
    createdAt: overrides.createdAt ?? "2026-04-04T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-04T00:00:00.000Z"
  };
}

describe("inferWorkItemStatus", () => {
  it("marks closed issues as completed so they do not stay claimable", () => {
    const status = inferWorkItemStatus(
      {
        state: "closed",
        workflowState: "ready"
      },
      {
        status: "ready"
      },
      null
    );

    expect(status).toBe("completed");
  });

  it("marks open issues with open pull requests as waiting_review", () => {
    const status = inferWorkItemStatus(
      {
        state: "open",
        workflowState: "ready"
      },
      null,
      {
        state: "open"
      }
    );

    expect(status).toBe("waiting_review");
  });
});

describe("selectQueuedWorkItems", () => {
  it("filters completed items out of the visible queue and keeps open work ordered", () => {
    const queue = selectQueuedWorkItems([
      makeWorkItem({ issueNumber: 28, status: "queued", priorityBucket: 2 }),
      makeWorkItem({ id: 2, issueNumber: 21, status: "completed", priorityBucket: 2 }),
      makeWorkItem({ id: 3, issueNumber: 24, status: "ready", priorityBucket: 1 }),
      makeWorkItem({ id: 4, issueNumber: 26, status: "planning", priorityBucket: 1 })
    ]);

    expect(queue.map((workItem) => workItem.issueNumber)).toEqual([24, 26, 28]);
  });
});

describe("selectActiveWorkItems", () => {
  it("returns only active work slices in issue order", () => {
    const active = selectActiveWorkItems([
      makeWorkItem({ issueNumber: 26, status: "waiting_review" }),
      makeWorkItem({ id: 2, issueNumber: 28, status: "queued" }),
      makeWorkItem({ id: 3, issueNumber: 24, status: "running" }),
      makeWorkItem({ id: 4, issueNumber: 30, status: "waiting_decision" })
    ]);

    expect(active.map((workItem) => workItem.issueNumber)).toEqual([24, 26, 30]);
  });
});
