export const IPC_CHANNELS = {
  setup: {
    getStatus: "director:setup:get-status",
    probeRepository: "director:setup:probe-repository",
    runWorkspaceTest: "director:setup:run-workspace-test",
    complete: "director:setup:complete"
  },
  director: {
    getOverview: "director:get-overview",
    getInbox: "director:get-inbox",
    getIntake: "director:get-intake",
    submitIntakeMessage: "director:submit-intake-message",
    actOnBrief: "director:act-on-brief",
    actOnTask: "director:act-on-task",
    sync: "director:sync",
    runIssue: "director:run-issue",
    reviewPr: "director:review-pr",
    mergePr: "director:merge-pr"
  }
} as const;
