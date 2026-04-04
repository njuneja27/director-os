import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface StoredProjectConfig {
  name: string;
  slug: string;
  repoPath: string;
  repoSlug: string;
  defaultBranch: string;
  worktreeRoot: string;
  agentRunner: string;
  model: string;
  updatedAt: string;
}

export interface DirectorConfigFile {
  version: number;
  activeProjectSlug: string | null;
  projects: StoredProjectConfig[];
  updatedAt: string;
}

export interface RuntimePaths {
  homeDir: string;
  configPath: string;
  databasePath: string;
  logsDir: string;
  worktreesDir: string;
  tmpDir: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";
}

export function resolveRuntimePaths(homeDir = path.join(os.homedir(), ".director-os")): RuntimePaths {
  return {
    homeDir,
    configPath: path.join(homeDir, "config.json"),
    databasePath: path.join(homeDir, "director.sqlite"),
    logsDir: path.join(homeDir, "logs"),
    worktreesDir: path.join(homeDir, "worktrees"),
    tmpDir: path.join(homeDir, "tmp")
  };
}

export async function ensureRuntimeDirectories(paths = resolveRuntimePaths()): Promise<RuntimePaths> {
  await fs.mkdir(paths.homeDir, { recursive: true });
  await Promise.all([
    fs.mkdir(paths.logsDir, { recursive: true }),
    fs.mkdir(paths.worktreesDir, { recursive: true }),
    fs.mkdir(paths.tmpDir, { recursive: true })
  ]);
  return paths;
}

function defaultConfig(): DirectorConfigFile {
  return {
    version: 1,
    activeProjectSlug: null,
    projects: [],
    updatedAt: nowIso()
  };
}

export async function loadConfig(paths = resolveRuntimePaths()): Promise<DirectorConfigFile> {
  await ensureRuntimeDirectories(paths);

  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DirectorConfigFile>;

    return {
      version: parsed.version ?? 1,
      activeProjectSlug: parsed.activeProjectSlug ?? null,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      updatedAt: parsed.updatedAt ?? nowIso()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const initial = defaultConfig();
      await saveConfig(initial, paths);
      return initial;
    }

    throw error;
  }
}

export async function saveConfig(config: DirectorConfigFile, paths = resolveRuntimePaths()): Promise<void> {
  await ensureRuntimeDirectories(paths);
  const nextConfig: DirectorConfigFile = {
    ...config,
    updatedAt: nowIso()
  };
  await fs.writeFile(paths.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export function upsertProjectConfig(
  config: DirectorConfigFile,
  project: StoredProjectConfig
): DirectorConfigFile {
  const existingIndex = config.projects.findIndex((candidate) => candidate.slug === project.slug);
  const projects = [...config.projects];

  if (existingIndex >= 0) {
    projects[existingIndex] = project;
  } else {
    projects.push(project);
  }

  return {
    ...config,
    projects
  };
}

export function getProjectConfig(
  config: DirectorConfigFile,
  slug: string | null | undefined
): StoredProjectConfig | null {
  if (!slug) {
    return null;
  }

  return config.projects.find((project) => project.slug === slug) ?? null;
}
