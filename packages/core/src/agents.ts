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
  sessionId?: string | null;
  addDirs?: string[];
}

export interface CodexRunResult {
  sessionId: string | null;
  result: AgentResultEnvelope;
}

export interface CodexSessionTurnResult {
  sessionId: string;
  message: string;
  rawMessage: string;
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

const issueTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "kind", "execution_mode"],
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    kind: { type: "string" },
    execution_mode: { type: "string" }
  }
} as const;

const structuredDataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: ["string", "null"] },
    guidance: { type: ["string", "null"] },
    transcript_reply: { type: ["string", "null"] },
    why_it_matters: { type: ["string", "null"] },
    question: { type: ["string", "null"] },
    recommendation: { type: ["string", "null"] },
    selected_issue_number: { type: ["number", "null"] },
    execution_intent: { type: ["string", "null"] },
    rationale: { type: ["string", "null"] },
    new_issues: {
      type: ["array", "null"],
      items: issueTaskSchema
    },
    child_tasks: {
      type: ["array", "null"],
      items: issueTaskSchema
    },
    decision: { type: ["string", "null"] },
    feedback: { type: ["string", "null"] },
    kind: { type: ["string", "null"] },
    reply: { type: ["string", "null"] },
    command_error: { type: ["string", "null"] }
  }
} as const;

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
    summary: { type: "string" },
    recommended_next_action: { type: "string" },
    artifact_refs: {
      type: "array",
      items: { type: "string" }
    },
    blocking_questions: {
      type: "array",
      items: { type: "string" }
    },
    data: structuredDataSchema
  }
} as const;

const probeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string" }
  }
} as const;

export interface CodexProbeResult {
  ok: boolean;
  reason: "ready" | "missing" | "auth_required" | "error";
  detail: string;
  advancedDetail?: string;
}

function parseThreadId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as { type?: string; thread_id?: string };
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        return parsed.thread_id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  return lines.length >= 3 ? lines.slice(1, -1).join("\n").trim() : trimmed;
}

export function parseJsonMessage(raw: string): Record<string, unknown> | null {
  const normalized = stripCodeFence(raw);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }

    try {
      const parsed = JSON.parse(normalized.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

async function runCodexCommand(
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    runner?: CommandRunner;
  }
): Promise<{ stdout: string; stderr: string }> {
  const result = await (options.runner ?? runCommandCapture)("codex", args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
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
    await runCodexCommand(
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

export async function runCodexSessionTurn(
  input: RunAgentOptions
): Promise<CodexSessionTurnResult> {
  const runtimePaths = await ensureRuntimeDirectories(resolveRuntimePaths());
  const stem = `${slugify(input.role)}-${Date.now()}`;
  const outputPath = path.join(runtimePaths.tmpDir, `${stem}.message.txt`);

  const args = input.sessionId
    ? [
        "exec",
        "resume",
        "--skip-git-repo-check",
        "--model",
        input.model,
        "--json",
        "--output-last-message",
        outputPath,
        input.sessionId,
        input.prompt
      ]
    : [
        "exec",
        "--skip-git-repo-check",
        "--cd",
        input.cwd,
        "--model",
        input.model,
        "--json",
        "--output-last-message",
        outputPath,
        "--sandbox",
        input.allowWrite ? "workspace-write" : "read-only",
        ...((input.addDirs ?? []).flatMap((directory) => ["--add-dir", directory])),
        input.prompt
      ];

  let stdout = "";
  let stderr = "";

  try {
    const result = await runCodexCommand(args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stderr = commandErrorText(error);
  }

  const rawMessage = await fs.readFile(outputPath, "utf8").catch(() => stderr || "");
  await fs.rm(outputPath, { force: true });

  const sessionId =
    parseThreadId(stdout) ??
    input.sessionId ??
    (() => {
      throw new Error("Codex did not report a session id.");
    })();

  return {
    sessionId,
    message: rawMessage.trim(),
    rawMessage,
    parsed: parseJsonMessage(rawMessage),
    stdout,
    stderr
  };
}

export async function runCodexSessionAgent(
  input: RunAgentOptions,
  fallback?: AgentResultEnvelope
): Promise<CodexRunResult> {
  if (input.sessionId) {
    const turn = await runCodexSessionTurn(input);
    const parsed = turn.parsed;
    const parsedStatus =
      parsed?.status === "ok" || parsed?.status === "needs_input" || parsed?.status === "failed"
        ? parsed.status
        : null;

    const structured =
      parsed &&
      parsedStatus &&
      typeof parsed.summary === "string" &&
      typeof parsed.recommended_next_action === "string"
        ? ({
            status: parsedStatus,
            summary: parsed.summary,
            recommended_next_action: parsed.recommended_next_action,
            artifact_refs: Array.isArray(parsed.artifact_refs)
              ? parsed.artifact_refs.filter((value): value is string => typeof value === "string")
              : [],
            blocking_questions: Array.isArray(parsed.blocking_questions)
              ? parsed.blocking_questions.filter((value): value is string => typeof value === "string")
              : [],
            data:
              parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
                ? (parsed.data as Record<string, unknown>)
                : {},
            raw_model_output: turn.rawMessage
          } satisfies AgentResultEnvelope)
        : null;

    return {
      sessionId: turn.sessionId,
      result:
        structured ??
        fallback ??
        ({
          status: "failed",
          summary: `Codex session returned an unstructured response for ${input.role}.`,
          recommended_next_action: "Inspect the stored raw session output and retry.",
          artifact_refs: [],
          blocking_questions: [],
          raw_model_output: turn.rawMessage
        } satisfies AgentResultEnvelope)
    };
  }

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
    outputPath,
    "--json",
    "--sandbox",
    input.allowWrite ? "workspace-write" : "read-only",
    ...((input.addDirs ?? []).flatMap((directory) => ["--add-dir", directory])),
    input.prompt
  ];

  let rawModelOutput: string | null = null;
  let sessionId: string | null = null;

  try {
    const result = await runCodexCommand(args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs
    });
    sessionId = parseThreadId(result.stdout);
    rawModelOutput = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(rawModelOutput) as AgentResultEnvelope;

    return {
      sessionId,
      result: {
        status: parsed.status,
        summary: parsed.summary,
        recommended_next_action: parsed.recommended_next_action,
        artifact_refs: Array.isArray(parsed.artifact_refs) ? parsed.artifact_refs : [],
        blocking_questions: Array.isArray(parsed.blocking_questions) ? parsed.blocking_questions : [],
        data:
          parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
            ? parsed.data
            : {},
        raw_model_output: rawModelOutput
      }
    };
  } catch (error) {
    const detail = commandErrorText(error);
    rawModelOutput = await fs.readFile(outputPath, "utf8").catch(() => detail || null);

    return {
      sessionId,
      result:
        fallback ??
        {
          status: "failed",
          summary: `Codex agent failed for ${input.role}: ${detail || String(error)}`,
          recommended_next_action: "Review the prompt, model, or workspace permissions and retry.",
          artifact_refs: [],
          blocking_questions: [],
          data: detail ? { command_error: detail } : {},
          raw_model_output: rawModelOutput
        }
    };
  } finally {
    await Promise.allSettled([
      fs.rm(schemaPath, { force: true }),
      fs.rm(outputPath, { force: true })
    ]);
  }
}

export async function runCodexAgent(
  input: RunAgentOptions,
  fallback?: AgentResultEnvelope
): Promise<AgentResultEnvelope> {
  const result = await runCodexSessionAgent(input, fallback);
  return result.result;
}
