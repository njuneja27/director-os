import type {
  BriefAction,
  BriefRecord,
  DirectorClient,
  DirectorOperationResponse,
  DirectorTaskAction,
  DirectorTaskRecord,
  HomeOverview,
  InboxResponse,
  IntakeResponse,
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
} from "@director-os/shared";

export type {
  SetupCheck,
  SetupProbeRepositoryInput,
  SetupRepositoryDraft,
  SetupStatusResponse
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

function hasElectronBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.director);
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
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
    getOverview: () => requestJson<HomeOverview>("/api/overview"),
    getInbox: () => requestJson<InboxResponse>("/api/inbox"),
    getIntake: () => requestJson<IntakeResponse>("/api/intake"),
    submitIntakeMessage: (content: string) =>
      requestJson<BriefRecord>("/api/intake/messages", {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    actOnBrief: (briefId: number, action: BriefAction) =>
      requestJson<BriefRecord>(`/api/briefs/${briefId}/actions`, {
        method: "POST",
        body: JSON.stringify({ action })
      }),
    actOnTask: (taskId: number, action: DirectorTaskAction) =>
      requestJson<DirectorTaskRecord>(`/api/tasks/${taskId}/actions`, {
        method: "POST",
        body: JSON.stringify({ action })
      }),
    sync: () =>
      requestJson<DirectorOperationResponse>("/api/sync", {
        method: "POST"
      }),
    runIssue: (issueNumber: number) =>
      requestJson<DirectorOperationResponse>(`/api/issues/${issueNumber}/run`, {
        method: "POST"
      }),
    reviewPr: (prNumber: number) =>
      requestJson<DirectorOperationResponse>(`/api/prs/${prNumber}/review`, {
        method: "POST"
      }),
    mergePr: (prNumber: number) =>
      requestJson<DirectorOperationResponse>(`/api/prs/${prNumber}/merge`, {
        method: "POST"
      })
  };
}

function createIpcDirectorClient(bridge: ElectronDirectorBridge): DirectorClient {
  return {
    getSetupStatus: () => bridge.setup.getStatus(),
    probeRepository: (input: SetupProbeRepositoryInput) => bridge.setup.probeRepository(input),
    runWorkspaceTest: (repositoryDraft: SetupRepositoryDraft) =>
      bridge.setup.runWorkspaceTest(repositoryDraft),
    completeSetup: (repositoryDraft: SetupRepositoryDraft) =>
      bridge.setup.complete(repositoryDraft),
    getOverview: () => bridge.director.getOverview(),
    getInbox: () => bridge.director.getInbox(),
    getIntake: () => bridge.director.getIntake(),
    submitIntakeMessage: (content: string) => bridge.director.submitIntakeMessage(content),
    actOnBrief: (briefId: number, action: BriefAction) => bridge.director.actOnBrief(briefId, action),
    actOnTask: (taskId: number, action: DirectorTaskAction) => bridge.director.actOnTask(taskId, action),
    sync: () => bridge.director.sync(),
    runIssue: (issueNumber: number) => bridge.director.runIssue(issueNumber),
    reviewPr: (prNumber: number) => bridge.director.reviewPr(prNumber),
    mergePr: (prNumber: number) => bridge.director.mergePr(prNumber)
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

export async function fetchOverview(): Promise<HomeOverview> {
  return getDirectorClient().getOverview();
}

export async function fetchInbox(): Promise<InboxResponse> {
  return getDirectorClient().getInbox();
}

export async function fetchIntake(): Promise<IntakeResponse> {
  return getDirectorClient().getIntake();
}

export async function syncNow(): Promise<DirectorOperationResponse> {
  return getDirectorClient().sync();
}

export async function sendIntakeMessage(content: string): Promise<BriefRecord> {
  return getDirectorClient().submitIntakeMessage(content);
}

export async function actOnBrief(briefId: number, action: BriefAction) {
  return getDirectorClient().actOnBrief(briefId, action);
}

export async function actOnTask(taskId: number, action: DirectorTaskAction) {
  return getDirectorClient().actOnTask(taskId, action);
}

export async function runIssue(issueNumber: number) {
  return getDirectorClient().runIssue(issueNumber);
}

export async function reviewPr(prNumber: number) {
  return getDirectorClient().reviewPr(prNumber);
}

export async function mergePr(prNumber: number) {
  return getDirectorClient().mergePr(prNumber);
}
