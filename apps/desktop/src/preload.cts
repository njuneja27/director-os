import { contextBridge, ipcRenderer } from "electron";

import type {
  BriefAction,
  BriefRecord,
  DirectorOperationResponse,
  DirectorTaskAction,
  DirectorTaskRecord,
  HomeOverview,
  InboxResponse,
  IntakeResponse,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

interface DesktopBridge {
  setup: {
    getStatus(): Promise<SetupStatusResponse>;
    probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
    runWorkspaceTest(input: SetupRepositoryDraft): Promise<SetupStatusResponse>;
    complete(input: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  };
  director: {
    getOverview(): Promise<HomeOverview>;
    getInbox(): Promise<InboxResponse>;
    getIntake(): Promise<IntakeResponse>;
    submitIntakeMessage(content: string): Promise<BriefRecord>;
    actOnBrief(briefId: number, action: BriefAction): Promise<BriefRecord>;
    actOnTask(taskId: number, action: DirectorTaskAction): Promise<DirectorTaskRecord>;
    sync(): Promise<DirectorOperationResponse>;
    runIssue(issueNumber: number): Promise<DirectorOperationResponse>;
    reviewPr(prNumber: number): Promise<DirectorOperationResponse>;
    mergePr(prNumber: number): Promise<DirectorOperationResponse>;
  };
}

const IPC_CHANNELS = {
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

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: DesktopBridge = {
  setup: {
    getStatus: () => invoke(IPC_CHANNELS.setup.getStatus),
    probeRepository: (input: SetupProbeRepositoryInput) =>
      invoke(IPC_CHANNELS.setup.probeRepository, input),
    runWorkspaceTest: (input: SetupRepositoryDraft) =>
      invoke(IPC_CHANNELS.setup.runWorkspaceTest, input),
    complete: (input: SetupRepositoryDraft) => invoke(IPC_CHANNELS.setup.complete, input)
  },
  director: {
    getOverview: () => invoke(IPC_CHANNELS.director.getOverview),
    getInbox: () => invoke(IPC_CHANNELS.director.getInbox),
    getIntake: () => invoke(IPC_CHANNELS.director.getIntake),
    submitIntakeMessage: (content: string) =>
      invoke(IPC_CHANNELS.director.submitIntakeMessage, content),
    actOnBrief: (briefId: number, action: BriefAction) =>
      invoke(IPC_CHANNELS.director.actOnBrief, briefId, action),
    actOnTask: (taskId: number, action: DirectorTaskAction) =>
      invoke(IPC_CHANNELS.director.actOnTask, taskId, action),
    sync: () => invoke(IPC_CHANNELS.director.sync),
    runIssue: (issueNumber: number) => invoke(IPC_CHANNELS.director.runIssue, issueNumber),
    reviewPr: (prNumber: number) => invoke(IPC_CHANNELS.director.reviewPr, prNumber),
    mergePr: (prNumber: number) => invoke(IPC_CHANNELS.director.mergePr, prNumber)
  }
};

contextBridge.exposeInMainWorld("director", api);
