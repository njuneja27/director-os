import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface StoredProjectConfig {
  id: number;
  name: string;
  slug: string;
  repoPath: string;
  repoSlug: string;
  defaultBranch: string;
  defaultBranchStrategy: "repo_default" | "custom" | null;
  worktreeRoot: string;
  agentRunner: string;
  createdAt: string;
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
  runtimeDir: string;
  logsDir: string;
  worktreesDir: string;
  tmpDir: string;
  orchestratorLockPath: string;
}

interface RuntimePathOptions {
  homedir?: string;
  platform?: NodeJS.Platform;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "project"
  );
}

export function resolveLegacyRuntimeHomeDir(options: RuntimePathOptions = {}): string {
  const homedir = options.homedir ?? os.homedir();
  return path.join(homedir, ".director-os");
}

export function resolveDefaultRuntimeHomeDir(options: RuntimePathOptions = {}): string {
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;

  return platform === "darwin"
    ? path.join(homedir, "Library", "Application Support", "Director OS")
    : resolveLegacyRuntimeHomeDir({ homedir, platform });
}

function resolveDefaultTmpDir(homeDir: string, options: RuntimePathOptions = {}): string {
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const preferredHomeDir = resolveDefaultRuntimeHomeDir({ homedir, platform });

  return platform === "darwin" && path.normalize(homeDir) === path.normalize(preferredHomeDir)
    ? path.join(homedir, "Library", "Caches", "Director OS", "tmp")
    : path.join(homeDir, "tmp");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasRuntimePayload(paths: RuntimePaths): Promise<boolean> {
  return pathExists(paths.configPath);
}

export function resolveRuntimePaths(
  homeDir = resolveDefaultRuntimeHomeDir(),
  options: RuntimePathOptions = {}
): RuntimePaths {
  return {
    homeDir,
    configPath: path.join(homeDir, "config.json"),
    runtimeDir: path.join(homeDir, "runtime"),
    logsDir: path.join(homeDir, "logs"),
    worktreesDir: path.join(homeDir, "worktrees"),
    tmpDir: resolveDefaultTmpDir(homeDir, options),
    orchestratorLockPath: path.join(homeDir, "orchestrator.lock.json")
  };
}

export async function resolveActiveRuntimePaths(
  options: RuntimePathOptions = {}
): Promise<RuntimePaths> {
  const platform = options.platform ?? process.platform;
  const preferredPaths = resolveRuntimePaths(resolveDefaultRuntimeHomeDir(options), options);

  if (platform !== "darwin") {
    return preferredPaths;
  }

  if (await hasRuntimePayload(preferredPaths)) {
    return preferredPaths;
  }

  const legacyHomeDir = resolveLegacyRuntimeHomeDir(options);
  if (path.normalize(legacyHomeDir) === path.normalize(preferredPaths.homeDir)) {
    return preferredPaths;
  }

  return (await pathExists(legacyHomeDir))
    ? resolveRuntimePaths(legacyHomeDir, options)
    : preferredPaths;
}

export async function ensureRuntimeDirectories(paths?: RuntimePaths): Promise<RuntimePaths> {
  const resolvedPaths = paths ?? (await resolveActiveRuntimePaths());

  await fs.mkdir(resolvedPaths.homeDir, { recursive: true });
  await Promise.all([
    fs.mkdir(resolvedPaths.runtimeDir, { recursive: true }),
    fs.mkdir(resolvedPaths.logsDir, { recursive: true }),
    fs.mkdir(resolvedPaths.worktreesDir, { recursive: true }),
    fs.mkdir(resolvedPaths.tmpDir, { recursive: true })
  ]);
  return resolvedPaths;
}

function defaultConfig(): DirectorConfigFile {
  return {
    version: 1,
    activeProjectSlug: null,
    projects: [],
    updatedAt: nowIso()
  };
}

function normalizeStoredProject(
  project: Partial<StoredProjectConfig>,
  index: number,
  paths: RuntimePaths
): StoredProjectConfig {
  const updatedAt = project.updatedAt ?? nowIso();
  const slug = project.slug ?? "project";

  return {
    id: project.id ?? index + 1,
    name: project.name ?? "Project",
    slug,
    repoPath: project.repoPath ?? "",
    repoSlug: project.repoSlug ?? "",
    defaultBranch: project.defaultBranch ?? "main",
    defaultBranchStrategy:
      project.defaultBranchStrategy === "custom"
        ? "custom"
        : project.defaultBranchStrategy === "repo_default"
          ? "repo_default"
          : null,
    worktreeRoot: project.worktreeRoot ?? path.join(paths.worktreesDir, slug),
    agentRunner: project.agentRunner ?? "codex",
    createdAt: project.createdAt ?? updatedAt,
    model: project.model ?? "gpt-5.4",
    updatedAt
  };
}

export async function loadConfig(paths?: RuntimePaths): Promise<DirectorConfigFile> {
  const resolvedPaths = await ensureRuntimeDirectories(paths);

  try {
    const raw = await fs.readFile(resolvedPaths.configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DirectorConfigFile>;

    return {
      version: parsed.version ?? 1,
      activeProjectSlug: parsed.activeProjectSlug ?? null,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.map((project, index) =>
            normalizeStoredProject(project as Partial<StoredProjectConfig>, index, resolvedPaths)
          )
        : [],
      updatedAt: parsed.updatedAt ?? nowIso()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const initial = defaultConfig();
      await saveConfig(initial, resolvedPaths);
      return initial;
    }

    throw error;
  }
}

export async function saveConfig(config: DirectorConfigFile, paths?: RuntimePaths): Promise<void> {
  const resolvedPaths = await ensureRuntimeDirectories(paths);
  const nextConfig: DirectorConfigFile = {
    ...config,
    projects: config.projects.map((project, index) =>
      normalizeStoredProject(project, index, resolvedPaths)
    ),
    updatedAt: nowIso()
  };
  await fs.writeFile(resolvedPaths.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
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
