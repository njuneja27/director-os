import { contextBridge, ipcRenderer } from "electron";

import type {
  ConversationResponse,
  DecisionRecord,
  DecisionsResponse,
  DirectorDesktopBridge,
  DirectorNoteRecord,
  DirectorOperationResponse,
  DirectorStatusResponse,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

import { IPC_CHANNELS } from "./protocol.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: DirectorDesktopBridge = {
  conversation: {
    getConversation: () => invoke(IPC_CHANNELS.conversation.get),
    sendMessage: (content: string) => invoke(IPC_CHANNELS.conversation.send, content)
  },
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
    listDecisions: () => invoke(IPC_CHANNELS.director.listDecisions),
    resolveDecision: (decisionId: string, resolution: string) =>
      invoke(IPC_CHANNELS.director.resolveDecision, decisionId, resolution)
  }
};

contextBridge.exposeInMainWorld("director", api);
