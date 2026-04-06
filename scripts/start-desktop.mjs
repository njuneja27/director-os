import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModulesPath = path.join(rootDir, "node_modules");
const packageLockPath = path.join(rootDir, "package-lock.json");
const installedLockPath = path.join(nodeModulesPath, ".package-lock.json");
const electronPackagePath = path.join(nodeModulesPath, "electron");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const rawArgs = process.argv.slice(2);
const bootstrapOnly = rawArgs.includes("--bootstrap-only");
const launchArgs = rawArgs.filter((arg) => arg !== "--bootstrap-only");

function logStep(message) {
  console.log(`[director-os] ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    logStep(`Command terminated by signal ${result.signal}.`);
    process.exit(1);
  }
}

function needsDependencyBootstrap() {
  if (!existsSync(nodeModulesPath)) {
    return true;
  }

  if (!existsSync(electronPackagePath)) {
    return true;
  }

  try {
    if (lstatSync(nodeModulesPath).isSymbolicLink()) {
      return false;
    }
  } catch {
    return true;
  }

  if (!existsSync(packageLockPath) || !existsSync(installedLockPath)) {
    return true;
  }

  try {
    return statSync(installedLockPath).mtimeMs < statSync(packageLockPath).mtimeMs;
  } catch {
    return true;
  }
}

if (needsDependencyBootstrap()) {
  logStep("First run or dependency refresh detected. Running npm install.");
  run(npmCommand, ["install"]);
} else {
  logStep("Workspace dependencies are already bootstrapped.");
}

logStep("Refreshing desktop build artifacts.");
run(npmCommand, ["run", "desktop:build"]);

if (bootstrapOnly) {
  logStep("Bootstrap-only run complete. Skipping desktop launch.");
  process.exit(0);
}

logStep("Launching the desktop app.");
const desktopStartArgs = ["--prefix", "apps/desktop", "run", "start"];

if (launchArgs.length > 0) {
  desktopStartArgs.push("--", ...launchArgs);
}

run(npmCommand, desktopStartArgs);
