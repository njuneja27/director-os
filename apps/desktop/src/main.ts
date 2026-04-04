import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";

import {
  actOnBrief,
  actOnTask,
  completeSetup,
  getSetupStatus,
  getHomeOverview,
  getInbox,
  getIntakeState,
  mergePullRequestWorkflow,
  probeRepositorySetup,
  reviewPullRequestWorkflow,
  runIssueWorkflow,
  runWorkspaceSetupTest,
  submitIntakeMessage,
  syncProject
} from "@director-os/core";

import {
  type BriefAction,
  type BriefRecord,
  type DirectorOperationResponse,
  type DirectorTaskAction,
  type DirectorTaskRecord,
  type HomeOverview,
  type InboxResponse,
  type IntakeResponse,
  type SetupProbeRepositoryInput,
  type SetupRepositoryDraft
} from "@director-os/shared";

import {
  IPC_CHANNELS
} from "./protocol.js";

interface DesktopBridge {
  setup: {
    getStatus(): ReturnType<typeof getSetupStatus>;
    probeRepository(input: SetupProbeRepositoryInput): ReturnType<typeof probeRepositorySetup>;
    runWorkspaceTest(input: SetupRepositoryDraft): ReturnType<typeof runWorkspaceSetupTest>;
    complete(input: SetupRepositoryDraft): ReturnType<typeof completeSetup>;
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

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDist = path.resolve(currentDir, "../../web/dist/index.html");
const preloadPath = path.resolve(currentDir, "preload.js");
const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim() || process.env.ELECTRON_RENDERER_URL?.trim();

function registerHandlers() {
  const api: DesktopBridge = {
    setup: {
      getStatus: async () => getSetupStatus(),
      probeRepository: async (input: SetupProbeRepositoryInput) => probeRepositorySetup(input),
      runWorkspaceTest: async (input: SetupRepositoryDraft) => runWorkspaceSetupTest(input),
      complete: async (input: SetupRepositoryDraft) => completeSetup(input)
    },
    director: {
      getOverview: async () => getHomeOverview(),
      getInbox: async () => getInbox(),
      getIntake: async () => getIntakeState(),
      submitIntakeMessage: async (content: string) => submitIntakeMessage(content),
      actOnBrief: async (briefId: number, action: "approve" | "revise" | "reject") =>
        actOnBrief(briefId, action),
      actOnTask: async (taskId: number, action: "approve" | "reject" | "resolve") =>
        actOnTask(taskId, action),
      sync: async () => syncProject(),
      runIssue: async (issueNumber: number) => runIssueWorkflow(issueNumber),
      reviewPr: async (prNumber: number) => reviewPullRequestWorkflow(prNumber),
      mergePr: async (prNumber: number) => mergePullRequestWorkflow(prNumber)
    }
  };

  ipcMain.handle(IPC_CHANNELS.setup.getStatus, api.setup.getStatus);
  ipcMain.handle(IPC_CHANNELS.setup.probeRepository, (_event, input: SetupProbeRepositoryInput) =>
    api.setup.probeRepository(input)
  );
  ipcMain.handle(IPC_CHANNELS.setup.runWorkspaceTest, (_event, input: SetupRepositoryDraft) =>
    api.setup.runWorkspaceTest(input)
  );
  ipcMain.handle(IPC_CHANNELS.setup.complete, (_event, input: SetupRepositoryDraft) =>
    api.setup.complete(input)
  );

  ipcMain.handle(IPC_CHANNELS.director.getOverview, api.director.getOverview);
  ipcMain.handle(IPC_CHANNELS.director.getInbox, api.director.getInbox);
  ipcMain.handle(IPC_CHANNELS.director.getIntake, api.director.getIntake);
  ipcMain.handle(IPC_CHANNELS.director.submitIntakeMessage, (_event, content: string) =>
    api.director.submitIntakeMessage(content)
  );
  ipcMain.handle(IPC_CHANNELS.director.actOnBrief, (_event, briefId: number, action: "approve" | "revise" | "reject") =>
    api.director.actOnBrief(briefId, action)
  );
  ipcMain.handle(IPC_CHANNELS.director.actOnTask, (_event, taskId: number, action: "approve" | "reject" | "resolve") =>
    api.director.actOnTask(taskId, action)
  );
  ipcMain.handle(IPC_CHANNELS.director.sync, api.director.sync);
  ipcMain.handle(IPC_CHANNELS.director.runIssue, (_event, issueNumber: number) =>
    api.director.runIssue(issueNumber)
  );
  ipcMain.handle(IPC_CHANNELS.director.reviewPr, (_event, prNumber: number) =>
    api.director.reviewPr(prNumber)
  );
  ipcMain.handle(IPC_CHANNELS.director.mergePr, (_event, prNumber: number) =>
    api.director.mergePr(prNumber)
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#f3efe8",
    title: "Director OS",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: "detach" });
    return window;
  }

  void window.loadFile(rendererDist);
  return window;
}

app.whenReady().then(() => {
  app.setName("Director OS");
  registerHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
