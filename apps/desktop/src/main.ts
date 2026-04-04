import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");
const cliEntry = path.resolve(currentDir, "../../cli/dist/index.js");
const devServerUrl =
  process.env.VITE_DEV_SERVER_URL?.trim() || process.env.ELECTRON_RENDERER_URL?.trim();
const internalServerPort = Number(process.env.DIRECTOR_INTERNAL_PORT ?? "4311");
const internalServerUrl = `http://127.0.0.1:${internalServerPort}`;

let backendProcess: ChildProcess | null = null;
let backendReadyPromise: Promise<void> | null = null;

function resolveNodeExecutable(): string {
  return (
    process.env.DIRECTOR_NODE_PATH?.trim() ||
    process.env.npm_node_execpath?.trim() ||
    "node"
  );
}

async function isBackendHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${internalServerUrl}/api/health`);
    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

async function waitForBackend(timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isBackendHealthy()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Director OS backend did not become healthy at ${internalServerUrl}.`);
}

function startBackendProcess(): ChildProcess {
  const nodeExecutable = resolveNodeExecutable();
  console.log(`[director-backend] using node executable: ${nodeExecutable}`);

  const child = spawn(nodeExecutable, [cliEntry, "serve", "--port", String(internalServerPort)], {
    cwd: repoRoot,
    stdio: "pipe",
    env: {
      ...process.env
    }
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[director-backend] ${chunk}`);
  });

  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[director-backend] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    backendProcess = null;
    backendReadyPromise = null;

    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(
        `[director-backend] exited unexpectedly with code=${String(code)} signal=${String(signal)}`
      );
    }
  });

  return child;
}

async function ensureBackendReady(): Promise<void> {
  if (await isBackendHealthy()) {
    return;
  }

  if (!backendReadyPromise) {
    backendProcess = startBackendProcess();
    backendReadyPromise = waitForBackend();
  }

  return backendReadyPromise;
}

async function createWindow() {
  await ensureBackendReady();

  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#f3efe8",
    title: "Director OS",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: "detach" });
    return window;
  }

  await window.loadURL(internalServerUrl);
  return window;
}

function stopBackendProcess() {
  if (!backendProcess || backendProcess.killed) {
    return;
  }

  backendProcess.kill("SIGTERM");
  backendProcess = null;
  backendReadyPromise = null;
}

app.whenReady().then(async () => {
  app.setName("Director OS");
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopBackendProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
