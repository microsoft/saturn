// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { spawn, spawnSync } from 'node:child_process';

const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Narrow an unknown value to a plain string-keyed object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Options for {@link runCommand}. */
export interface RunCommandOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly shell?: boolean;
}

/** Captured result of a child process. */
export interface RunCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command and capture its output. Never throws on a non-zero exit code; the caller
 * inspects {@link RunCommandResult.status}. Throws only when the process cannot be spawned at all.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {}
): RunCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    input: options.input,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    shell: options.shell,
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error !== undefined) {
    throw new Error(`Failed to run "${command}": ${result.error.message}`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

/**
 * Asynchronous, non-blocking counterpart to {@link runCommand}. Spawns the child without blocking the
 * Node event loop, so the always-on dashboard stays responsive while long reviews and git fetches run.
 * Never rejects on a non-zero exit (the caller inspects {@link RunCommandResult.status}); rejects only
 * when the process cannot be spawned. A timeout kills the child and surfaces as a non-zero status.
 */
export function runCommandAsync(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: RunCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes <= MAX_CAPTURED_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes <= MAX_CAPTURED_OUTPUT_BYTES) {
        stderr += chunk;
      }
    });

    child.on('error', (error: Error) => {
      fail(new Error(`Failed to run "${command}": ${error.message}`));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({
          status: 1,
          stdout,
          stderr: `${stderr}\n[saturn] "${command}" timed out after ${String(options.timeoutMs)}ms and was killed.`
        });
        return;
      }
      finish({ status: code ?? (signal !== null ? 1 : 0), stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/** Prefix every line of `text` with a 1-based, right-aligned line number for stable anchoring. */
export function numberLines(text: string): string {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`).join('\n');
}

/** Convert an unknown thrown value into a human-readable message. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minimal logging surface used across the bot. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Default logger that writes to the console. */
export const consoleLogger: Logger = {
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(message);
  },
  error(message: string): void {
    console.error(message);
  }
};
