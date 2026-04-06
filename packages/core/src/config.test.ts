import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureRuntimeDirectories,
  resolveActiveRuntimePaths,
  resolveDefaultRuntimeHomeDir,
  resolveLegacyRuntimeHomeDir
} from "./config.js";

const cleanupTargets = new Set<string>();

async function createSandboxHome(): Promise<string> {
  const sandboxHome = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "director-os-runtime-home-"))
  );
  cleanupTargets.add(sandboxHome);
  return sandboxHome;
}

afterEach(async () => {
  await Promise.all(
    [...cleanupTargets].map((target) => fs.rm(target, { recursive: true, force: true }))
  );
  cleanupTargets.clear();
});

describe("resolveActiveRuntimePaths", () => {
  it("uses Application Support and Library/Caches for fresh macOS installs", async () => {
    const homedir = await createSandboxHome();

    const paths = await resolveActiveRuntimePaths({
      homedir,
      platform: "darwin"
    });

    expect(paths.homeDir).toBe(
      path.join(homedir, "Library", "Application Support", "Director OS")
    );
    expect(paths.tmpDir).toBe(path.join(homedir, "Library", "Caches", "Director OS", "tmp"));

    await ensureRuntimeDirectories(paths);

    await expect(fs.stat(paths.homeDir)).resolves.toBeTruthy();
    await expect(fs.stat(paths.tmpDir)).resolves.toBeTruthy();
  });

  it("keeps using the legacy dotfolder when an older macOS install already exists", async () => {
    const homedir = await createSandboxHome();
    const legacyHomeDir = resolveLegacyRuntimeHomeDir({ homedir, platform: "darwin" });
    await fs.mkdir(legacyHomeDir, { recursive: true });

    const paths = await resolveActiveRuntimePaths({
      homedir,
      platform: "darwin"
    });

    expect(paths.homeDir).toBe(legacyHomeDir);
    expect(paths.tmpDir).toBe(path.join(legacyHomeDir, "tmp"));
  });

  it("prefers the native macOS location once Application Support already exists", async () => {
    const homedir = await createSandboxHome();
    const preferredHomeDir = resolveDefaultRuntimeHomeDir({
      homedir,
      platform: "darwin"
    });
    const legacyHomeDir = resolveLegacyRuntimeHomeDir({ homedir, platform: "darwin" });

    await fs.mkdir(preferredHomeDir, { recursive: true });
    await fs.mkdir(legacyHomeDir, { recursive: true });

    const paths = await resolveActiveRuntimePaths({
      homedir,
      platform: "darwin"
    });

    expect(paths.homeDir).toBe(preferredHomeDir);
    expect(paths.tmpDir).toBe(path.join(homedir, "Library", "Caches", "Director OS", "tmp"));
  });

  it("leaves non-macOS defaults unchanged", async () => {
    const homedir = await createSandboxHome();

    const paths = await resolveActiveRuntimePaths({
      homedir,
      platform: "linux"
    });

    expect(paths.homeDir).toBe(path.join(homedir, ".director-os"));
    expect(paths.tmpDir).toBe(path.join(homedir, ".director-os", "tmp"));
  });
});
