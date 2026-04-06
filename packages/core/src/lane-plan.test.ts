import { describe, expect, it } from "vitest";

import { extractLanePlanIssueTasks } from "./lane-plan.js";

describe("extractLanePlanIssueTasks", () => {
  it("parses child issue proposals from new_issues", () => {
    expect(
      extractLanePlanIssueTasks({
        new_issues: [
          {
            title: "Split the orchestrator review queue",
            body: "Implement the queue split.",
            kind: "task",
            execution_mode: "lane"
          }
        ]
      })
    ).toEqual([
      {
        title: "Split the orchestrator review queue",
        body: "Implement the queue split.",
        kind: "task",
        execution_mode: "lane"
      }
    ]);
  });

  it("ignores the legacy child_tasks field when no new_issues are present", () => {
    expect(
      extractLanePlanIssueTasks({
        child_tasks: [
          {
            title: "Legacy child task",
            body: "This should be ignored.",
            kind: "task",
            execution_mode: "lane"
          }
        ]
      })
    ).toEqual([]);
  });
});
