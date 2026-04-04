export const IPC_CHANNELS = {
  setup: {
    getStatus: "director:setup:get-status",
    probeRepository: "director:setup:probe-repository",
    runWorkspaceTest: "director:setup:run-workspace-test",
    complete: "director:setup:complete"
  },
  director: {
    getStatus: "director:get-status",
    start: "director:start",
    pause: "director:pause",
    sync: "director:sync",
    submitNote: "director:submit-note",
    listDecisions: "director:list-decisions",
    resolveDecision: "director:resolve-decision"
  }
} as const;
