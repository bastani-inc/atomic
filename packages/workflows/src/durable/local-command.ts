/** Minimal subprocess and TCP helpers for local DBOS database provisioning. */

import { spawn } from "node:child_process";
import { connect } from "node:net";

export interface LocalCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const OUTPUT_LIMIT_BYTES = 16_384;

export interface LocalCommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  /** POSIX drop-privilege identity for the spawned process (root only). */
  readonly uid?: number;
  readonly gid?: number;
}

export function runLocalCommand(
  command: string,
  args: readonly string[],
  options?: LocalCommandOptions,
): Promise<LocalCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options?.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
      ...(options?.uid !== undefined ? { uid: options.uid } : {}),
      ...(options?.gid !== undefined ? { gid: options.gid } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = boundedAppend(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

export function commandFailureDetail(result: LocalCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a TCP listener accepts a connection on host:port within the timeout. */
export function tcpReachable(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= OUTPUT_LIMIT_BYTES ? next : next.slice(-OUTPUT_LIMIT_BYTES);
}
