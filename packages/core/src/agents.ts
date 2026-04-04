import fs from "node:fs/promises";
import path from "node:path";

import type { AgentResultEnvelope } from "@director-os/shared";

import { ensureRuntimeDirectories, resolveRuntimePaths, slugify } from "./config.js";
import {
  commandErrorText,
  isMissingBinaryError,
  runCommandCapture,
  type CommandRunner
} from "./commands.js";

export interface RunAgentOptions {
  role:
    | "chief_of_staff"
    | "lane_owner"
    | "worker"
    | "reviewer"
    | "validator"
    | "pr_watcher";
  prompt: string;
  cwd: string;
  model: string;
  allowWrite?: boolean;
  timeoutMs?: number;
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "recommended_next_action",
    "artifact_refs",
    "blocking_questions"
  ],
  properties: {
    status: {
      type: "string",
      enum: ["ok", "needs_input", "failed"]
    },
    summary: {
      type: "string"
    },
    recommended_next_action: {
      type: "string"
    },
    artifact_refs: {
      type: "array",
      items: {
        type: "string"
      }
    },
    blocking_questions: {
      type: "array",
      items: {
        type: "string"
      }
    },
    data: {
      type: "object",
      additionalProperties: true
    }
  }
} as const;

const probeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string"
    }
  }
} as const;

export interface CodexProbeResult {
  ok: boolean;
  reason: "ready" | "missing" | "auth_required" | "error";
  detail: string;
  advancedDetail?: string;
}

async function runCodexExec(
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    runner?: CommandRunner;
  }
): Promise<void> {
  await (options.runner ?? runCommandCapture)("codex", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024
  });
}

export async function probeCodexCli(
  model = "gpt-5.4-mini",
  runner: CommandRunner = runCommandCapture
): Promise<CodexProbeResult> {
  const runtimePaths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const stem = `codex-probe-${Date.now()}`;
  const schemaPath = path.join(runtimePaths.tmpDir, `${stem}.schema.json`);
  const outputPath = path.join(runtimePaths.tmpDir, `${stem}.output.json`);
  const probeDir = path.join(runtimePaths.tmpDir, stem);

  await fs.mkdir(probeDir, { recursive: true });
  await fs.writeFile(schemaPath, `${JSON.stringify(probeSchema, null, 2)}\n`, "utf8");

  try {
    await runCodexExec(
      [
        "exec",
        "--skip-git-repo-check",
        "--cd",
        probeDir,
        "--model",
        model,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--sandbox",
        "read-only",
        "Return a JSON object with a single `status` field set to `ready`."
      ],
      {
        cwd: probeDir,
        timeoutMs: 90 * 1000,
        runner
      }
    );

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as { status?: string };

    if (typeof parsed.status !== "string" || !parsed.status.trim()) {
      throw new Error("Codex probe completed without the expected structured output.");
    }

    return {
      ok: true,
      reason: "ready",
      detail: "Codex is installed and ready for local runs."
    };
  } catch (error) {
    const detail = commandErrorText(error);

    if (isMissingBinaryError(error)) {
      return {
        ok: false,
        reason: "missing",
        detail: "Codex was not found on this machine.",
        advancedDetail: detail || "Command checked: codex exec"
      };
    }

    if (/sign in|login|authenticate|unauthorized|session/i.test(detail)) {
      return {
        ok: false,
        reason: "auth_required",
        detail: "Codex is installed, but sign-in is required.",
        advancedDetail: detail
      };
    }

    return {
      ok: false,
      reason: "error",
      detail: "Codex could not complete a local proof-of-life run.",
      advancedDetail: detail
    };
  } finally {
    await Promise.allSettled([
      fs.rm(schemaPath, { force: true }),
      fs.rm(outputPath, { force: true }),
      fs.rm(probeDir, { recursive: true, force: true })
    ]);
  }
}

export async function runCodexAgent(
  input: RunAgentOptions,
  fallback?: AgentResultEnvelope
): Promise<AgentResultEnvelope> {
  const runtimePaths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const stem = `${slugify(input.role)}-${Date.now()}`;
  const schemaPath = path.join(runtimePaths.tmpDir, `${stem}.schema.json`);
  const outputPath = path.join(runtimePaths.tmpDir, `${stem}.output.json`);

  await fs.writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    input.cwd,
    "--model",
    input.model,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath
  ];

  if (input.allowWrite) {
    args.push("--sandbox", "workspace-write");
  } else {
    args.push("--sandbox", "read-only");
  }

  args.push(input.prompt);

  try {
    await runCodexExec(args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as AgentResultEnvelope;

    return {
      status: parsed.status,
      summary: parsed.summary,
      recommended_next_action: parsed.recommended_next_action,
      artifact_refs: Array.isArray(parsed.artifact_refs) ? parsed.artifact_refs : [],
      blocking_questions: Array.isArray(parsed.blocking_questions) ? parsed.blocking_questions : [],
      data: parsed.data ?? {}
    };
  } catch (error) {
    if (fallback) {
      return fallback;
    }

    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "failed",
      summary: `Codex agent failed for ${input.role}: ${message}`,
      recommended_next_action: "Review the prompt, model, or workspace permissions and retry.",
      artifact_refs: [],
      blocking_questions: []
    };
  } finally {
    await Promise.allSettled([
      fs.rm(schemaPath, { force: true }),
      fs.rm(outputPath, { force: true })
    ]);
  }
}
