import type {
  ConversationMessageRecord,
  ConversationResponse,
  ConversationThreadRecord,
  DirectorClient,
  DirectorDesktopBridge,
  DirectorOperationResponse,
  DirectorStatusResponse,
  HumanQuestionRecord,
  RunRecord,
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

export type {
  ConversationMessageRecord,
  ConversationResponse,
  ConversationThreadRecord,
  DirectorStatusResponse,
  HumanQuestionRecord,
  RunRecord,
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

declare global {
  interface Window {
    director?: DirectorDesktopBridge;
  }
}

interface WebDirectorClient extends DirectorClient {
  getConversation(): Promise<ConversationResponse>;
  sendMessage(content: string): Promise<ConversationResponse>;
}

function hasElectronBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.director);
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function createHttpDirectorClient(): WebDirectorClient {
  return {
    getConversation: () => requestJson<ConversationResponse>("/api/conversation"),
    sendMessage: (content: string) =>
      requestJson<ConversationResponse>("/api/conversation", {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    getSetupStatus: () => requestJson<SetupStatusResponse>("/api/setup/status"),
    probeRepository: (input: SetupProbeRepositoryInput) =>
      requestJson<SetupStatusResponse>("/api/setup/probe-repository", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    runWorkspaceTest: (repositoryDraft: SetupRepositoryDraft) =>
      requestJson<SetupStatusResponse>("/api/setup/run-workspace-test", {
        method: "POST",
        body: JSON.stringify({ repositoryDraft })
      }),
    completeSetup: (repositoryDraft: SetupRepositoryDraft) =>
      requestJson<SetupStatusResponse>("/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({ repositoryDraft })
      }),
    getStatus: () => requestJson<DirectorStatusResponse>("/api/status"),
    start: () =>
      requestJson<DirectorOperationResponse>("/api/start", {
        method: "POST"
      }),
    pause: (reason?: string) =>
      requestJson<DirectorOperationResponse>("/api/pause", {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {})
      }),
    sync: () =>
      requestJson<DirectorOperationResponse>("/api/sync", {
        method: "POST"
      }),
    resetRouterRuntime: () =>
      requestJson<DirectorOperationResponse>("/api/reset-router-runtime", {
        method: "POST"
      })
  };
}

function createIpcDirectorClient(bridge: DirectorDesktopBridge): WebDirectorClient {
  return {
    getConversation: () => bridge.conversation.getConversation(),
    sendMessage: (content: string) => bridge.conversation.sendMessage(content),
    getSetupStatus: () => bridge.setup.getStatus(),
    probeRepository: (input: SetupProbeRepositoryInput) => bridge.setup.probeRepository(input),
    runWorkspaceTest: (repositoryDraft: SetupRepositoryDraft) =>
      bridge.setup.runWorkspaceTest(repositoryDraft),
    completeSetup: (repositoryDraft: SetupRepositoryDraft) => bridge.setup.complete(repositoryDraft),
    getStatus: () => bridge.director.getStatus(),
    start: () => bridge.director.start(),
    pause: (reason?: string) => bridge.director.pause(reason),
    sync: () => bridge.director.sync(),
    resetRouterRuntime: () => bridge.director.resetRouterRuntime()
  };
}

let cachedClient: WebDirectorClient | null = null;

export function getDirectorClient(): WebDirectorClient {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = hasElectronBridge()
    ? createIpcDirectorClient(window.director as DirectorDesktopBridge)
    : createHttpDirectorClient();

  return cachedClient;
}

export async function fetchConversation(): Promise<ConversationResponse> {
  return getDirectorClient().getConversation();
}

export async function sendMessage(content: string): Promise<ConversationResponse> {
  return getDirectorClient().sendMessage(content);
}

export async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return getDirectorClient().getSetupStatus();
}

export async function probeRepository(
  input: SetupProbeRepositoryInput
): Promise<SetupStatusResponse> {
  return getDirectorClient().probeRepository(input);
}

export async function runWorkspaceTest(
  input: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return getDirectorClient().runWorkspaceTest(input);
}

export async function completeSetup(
  input: SetupRepositoryDraft
): Promise<SetupStatusResponse> {
  return getDirectorClient().completeSetup(input);
}

export async function fetchStatus(): Promise<DirectorStatusResponse> {
  return getDirectorClient().getStatus();
}

export async function startDirector(): Promise<DirectorOperationResponse> {
  return getDirectorClient().start();
}

export async function pauseDirector(reason?: string): Promise<DirectorOperationResponse> {
  return getDirectorClient().pause(reason);
}

export async function syncNow(): Promise<DirectorOperationResponse> {
  return getDirectorClient().sync();
}

export async function resetRouterRuntime(): Promise<DirectorOperationResponse> {
  return getDirectorClient().resetRouterRuntime();
}
