import type {
  DecisionRecord,
  DecisionsResponse,
  DirectorClient,
  DirectorNoteRecord,
  DirectorOperationResponse,
  DirectorStatusResponse,
  PrCycleRecord,
  RunRecord,
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse,
  WorkItemRecord
} from "@director-os/shared";

export type {
  DecisionRecord,
  DecisionsResponse,
  DirectorNoteRecord,
  DirectorStatusResponse,
  PrCycleRecord,
  RunRecord,
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse,
  WorkItemRecord
} from "@director-os/shared";

declare global {
  interface Window {
    director?: ElectronDirectorBridge;
  }
}

interface ElectronDirectorBridge {
  setup: {
    getStatus(): Promise<SetupStatusResponse>;
    probeRepository(input: SetupProbeRepositoryInput): Promise<SetupStatusResponse>;
    runWorkspaceTest(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
    complete(repositoryDraft: SetupRepositoryDraft): Promise<SetupStatusResponse>;
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

function createHttpDirectorClient(): DirectorClient {
  return {
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
    submitNote: (content: string) =>
      requestJson<DirectorNoteRecord>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    listDecisions: () => requestJson<DecisionsResponse>("/api/decisions"),
    resolveDecision: (decisionId: number, resolution: string) =>
      requestJson<DecisionRecord>(`/api/decisions/${decisionId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution })
      })
  };
}

function createIpcDirectorClient(bridge: ElectronDirectorBridge): DirectorClient {
  return {
    getSetupStatus: () => bridge.setup.getStatus(),
    probeRepository: (input: SetupProbeRepositoryInput) => bridge.setup.probeRepository(input),
    runWorkspaceTest: (repositoryDraft: SetupRepositoryDraft) =>
      bridge.setup.runWorkspaceTest(repositoryDraft),
    completeSetup: (repositoryDraft: SetupRepositoryDraft) => bridge.setup.complete(repositoryDraft),
    getStatus: () => bridge.director.getStatus(),
    start: () => bridge.director.start(),
    pause: (reason?: string) => bridge.director.pause(reason),
    sync: () => bridge.director.sync(),
    submitNote: (content: string) => bridge.director.submitNote(content),
    listDecisions: () => bridge.director.listDecisions(),
    resolveDecision: (decisionId: number, resolution: string) =>
      bridge.director.resolveDecision(decisionId, resolution)
  };
}

let cachedClient: DirectorClient | null = null;

export function getDirectorClient(): DirectorClient {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = hasElectronBridge()
    ? createIpcDirectorClient(window.director as ElectronDirectorBridge)
    : createHttpDirectorClient();

  return cachedClient;
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

export async function submitNote(content: string): Promise<DirectorNoteRecord> {
  return getDirectorClient().submitNote(content);
}

export async function fetchDecisions(): Promise<DecisionsResponse> {
  return getDirectorClient().listDecisions();
}

export async function resolveEscalation(
  decisionId: number,
  resolution: string
): Promise<DecisionRecord> {
  return getDirectorClient().resolveDecision(decisionId, resolution);
}
