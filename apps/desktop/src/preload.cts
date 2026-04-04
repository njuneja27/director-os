import { contextBridge, ipcRenderer } from "electron";

import type {
  DecisionRecord,
  DecisionsResponse,
  DirectorNoteRecord,
  DirectorOperationResponse,
  DirectorStatusResponse,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

import { IPC_CHANNELS } from "./protocol.js";

interface DesktopBridge {
  setup: {
    getStatus(): Promise<SetupStatusResponse>;
    probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
    runWorkspaceTest(input: SetupRepositoryDraft): Promise<SetupStatusResponse>;
    complete(input: SetupRepositoryDraft): Promise<SetupStatusResponse>;
  };
  director: {
    getStatus(): Promise<DirectorStatusResponse>;
    start(): Promise<DirectorOperationResponse>;
    pause(reason?: string): Promise<DirectorOperationResponse>;
    sync(): Promise<DirectorOperationResponse>;
    submitNote(content: string): Promise<DirectorNoteRecord>;
    listDecisions(): Promise<DecisionsResponse>;
    resolveDecision(decisionId: number, resolution: string): Promise<DecisionRecord>;
  };
}

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
    getStatus: () => invoke(IPC_CHANNELS.director.getStatus),
    start: () => invoke(IPC_CHANNELS.director.start),
    pause: (reason?: string) => invoke(IPC_CHANNELS.director.pause, reason),
    sync: () => invoke(IPC_CHANNELS.director.sync),
    submitNote: (content: string) => invoke(IPC_CHANNELS.director.submitNote, content),
    listDecisions: () => invoke(IPC_CHANNELS.director.listDecisions),
    resolveDecision: (decisionId: number, resolution: string) =>
      invoke(IPC_CHANNELS.director.resolveDecision, decisionId, resolution)
  }
};

contextBridge.exposeInMainWorld("director", api);
