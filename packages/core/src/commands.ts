import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandExecutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandExecutionError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  status?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandExecutionOptions
) => Promise<CommandExecutionResult>;

export const runCommandCapture: CommandRunner = async (
  command,
  args,
  options = {}
) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: 0
  };
};

export async function runCommandOrThrow(
  command: string,
  args: string[],
  options?: CommandExecutionOptions
): Promise<string> {
  const result = await runCommandCapture(command, args, options);
  return result.stdout;
}

export function commandErrorText(error: unknown): string {
  if (error instanceof Error) {
    const maybeCommandError = error as CommandExecutionError;
    return [maybeCommandError.stderr, maybeCommandError.stdout, maybeCommandError.message]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return String(error);
}

export function isMissingBinaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeCommandError = error as CommandExecutionError;
  return maybeCommandError.code === "ENOENT" || /spawn .* ENOENT/i.test(maybeCommandError.message);
}
