import type {
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  WorkItemRecord,
  WorkItemStatus
} from "@director-os/shared";

const QUEUED_STATUSES = new Set<WorkItemStatus>(["queued", "ready", "planning"]);
const ACTIVE_STATUSES = new Set<WorkItemStatus>(["running", "waiting_review", "waiting_decision"]);

export function inferWorkItemStatus(
  issue: Pick<GitHubIssueRecord, "state" | "workflowState">,
  existing: Pick<WorkItemRecord, "status"> | null,
  linkedPr: Pick<GitHubPullRequestRecord, "state"> | null
): WorkItemStatus {
  if (issue.state.toLowerCase() !== "open") {
    return "completed";
  }

  if (linkedPr && linkedPr.state.toLowerCase() === "open") {
    return "waiting_review";
  }

  if (existing && ["running", "planning", "waiting_decision"].includes(existing.status)) {
    return existing.status;
  }

  if (issue.workflowState === "ready") {
    return "ready";
  }

  if (issue.workflowState === "blocked") {
    return "blocked";
  }

  return "queued";
}

export function selectQueuedWorkItems(workItems: WorkItemRecord[]): WorkItemRecord[] {
  return workItems
    .filter((workItem) => QUEUED_STATUSES.has(workItem.status))
    .sort((left, right) => left.priorityBucket - right.priorityBucket || left.issueNumber - right.issueNumber);
}

export function selectActiveWorkItems(workItems: WorkItemRecord[]): WorkItemRecord[] {
  return workItems
    .filter((workItem) => ACTIVE_STATUSES.has(workItem.status))
    .sort((left, right) => left.issueNumber - right.issueNumber);
}
