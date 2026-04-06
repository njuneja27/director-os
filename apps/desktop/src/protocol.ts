export const IPC_CHANNELS = {
  conversation: {
    get: "director:conversation:get",
    send: "director:conversation:send"
  },
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
    resetRouterRuntime: "director:reset-router-runtime"
  }
} as const;
