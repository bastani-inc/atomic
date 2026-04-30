/**
 * Cross-platform TCP port discovery for child processes.
 *
 * Polls the kernel's per-process socket table until a listening TCP port
 * is found for the given PID, or until the timeout elapses.
 *
 * Platform implementations:
 *   - Linux: /proc/<pid>/net/tcp + /proc/<pid>/fd/* (no external binary)
 *   - macOS: lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>
 *   - Windows: Get-NetTCPConnection PowerShell; falls back to netstat -ano
 */

import {
  existsSync,
  readdirSync,
  readlinkSync,
  readFileSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const PORT_DISCOVERY_TIMEOUT_MS = 15_000;

export interface GetListeningPortOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

type PortDiscoverySpawnOptions = {
  cmd: string[];
  stdout: "pipe";
  stderr: "pipe";
};

type PortDiscoverySpawnResult = {
  stdout: { toString(): string };
  stderr: { toString(): string };
  success: boolean;
};

type PortDiscoverySpawnSync = (options: PortDiscoverySpawnOptions) => PortDiscoverySpawnResult;

let spawnSync: PortDiscoverySpawnSync = (options) => Bun.spawnSync(options);

export function _setPortDiscoverySpawnSyncForTest(nextSpawnSync: PortDiscoverySpawnSync): () => void {
  const previous = spawnSync;
  spawnSync = nextSpawnSync;
  return () => {
    spawnSync = previous;
  };
}

/**
 * Discover the TCP port that a given process is listening on.
 *
 * Polls the kernel's per-process socket table at ~500ms intervals until
 * a listening port is found or the timeout elapses. Returns null on
 * timeout (caller is responsible for throwing if that's an error).
 */
export async function getListeningPortForPid(
  pid: number,
  options?: GetListeningPortOptions,
): Promise<number | null> {
  const timeoutMs = options?.timeoutMs ?? PORT_DISCOVERY_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const port = _readListeningPortForPid(pid);
    if (port !== null) return port;
    if (!_isProcessAlive(pid)) return null;
    await Bun.sleep(pollIntervalMs);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

export function _readListeningPortForPid(pid: number): number | null {
  const platform = process.platform;
  if (platform === "linux") {
    return linuxReadListeningPort(pid, 0);
  } else if (platform === "darwin") {
    return _macosReadListeningPort(pid, 0);
  } else {
    return _windowsReadListeningPort(pid, 0);
  }
}

export function _isProcessAlive(pid: number): boolean {
  if (process.platform === "linux") {
    return existsSync(`/proc/${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux implementation
// ---------------------------------------------------------------------------

const LINUX_MAX_CHILD_DEPTH = 3;

/**
 * Parse a single /proc/net/tcp or /proc/net/tcp6 line.
 * Returns {inode, port} for LISTEN sockets (state 0A), or null otherwise.
 */
export function _parseLinuxTcpLine(line: string): { inode: number; port: number } | null {
  // Format: sl  local_address  rem_address  st  tx:rx  tr:when  retrans  uid  timeout  inode
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("sl")) return null;

  const cols = trimmed.split(/\s+/);
  if (cols.length < 10) return null;

  const localAddr: string = cols[1] ?? "";
  const stateHex: string = cols[3] ?? "";
  const inodeStr: string = cols[9] ?? "";

  // Only LISTEN state (0x0A)
  if (stateHex.toUpperCase() !== "0A") return null;
  if (!localAddr) return null;

  const colonIdx = localAddr.indexOf(":");
  if (colonIdx === -1) return null;

  // Port is big-endian hex after the colon
  const portHex = localAddr.slice(colonIdx + 1);
  const port = parseInt(portHex, 16);
  if (isNaN(port) || port <= 0) return null;

  const inode = parseInt(inodeStr, 10);
  if (isNaN(inode)) return null;

  return { inode, port };
}

/** Parse /proc/net/tcp or /proc/net/tcp6 content. Returns map of inode -> port for LISTEN sockets. */
export function _parseLinuxTcpTable(content: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of content.split("\n")) {
    const entry = _parseLinuxTcpLine(line);
    if (entry !== null) {
      result.set(entry.inode, entry.port);
    }
  }
  return result;
}

/** Get socket inodes owned by a PID via /proc/<pid>/fd/* symlinks. */
export function _getLinuxPidSocketInodes(pid: number): Set<number> {
  const inodes = new Set<number>();
  const fdDir = `/proc/${pid}/fd`;
  if (!existsSync(fdDir)) return inodes;

  let fds: string[];
  try {
    fds = readdirSync(fdDir);
  } catch {
    return inodes;
  }

  for (const fd of fds) {
    try {
      const target = readlinkSync(`${fdDir}/${fd}`);
      // Socket symlinks look like: socket:[<inode>]
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match && match[1]) {
        inodes.add(parseInt(match[1], 10));
      }
    } catch {
      // Permission denied or fd disappeared — skip
    }
  }
  return inodes;
}

function readProcFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function _linuxGetListeningPort(
  tcpContent: string,
  tcp6Content: string,
  socketInodes: Set<number>,
): number | null {
  const table4 = _parseLinuxTcpTable(tcpContent);
  const table6 = _parseLinuxTcpTable(tcp6Content);

  for (const inode of socketInodes) {
    const port4 = table4.get(inode);
    if (port4 !== undefined) return port4;
    const port6 = table6.get(inode);
    if (port6 !== undefined) return port6;
  }
  return null;
}

function linuxReadListeningPort(pid: number, depth: number): number | null {
  if (depth > LINUX_MAX_CHILD_DEPTH) return null;

  const tcpContent = readProcFile(`/proc/${pid}/net/tcp`);
  const tcp6Content = readProcFile(`/proc/${pid}/net/tcp6`);
  const socketInodes = _getLinuxPidSocketInodes(pid);

  const port = _linuxGetListeningPort(tcpContent, tcp6Content, socketInodes);
  if (port !== null) return port;

  // Walk children if no listening port found
  const children = _linuxGetChildren(pid);
  for (const childPid of children) {
    const childPort = linuxReadListeningPort(childPid, depth + 1);
    if (childPort !== null) return childPort;
  }
  return null;
}

export function _linuxGetChildren(pid: number): number[] {
  // /proc/<pid>/task/<pid>/children lists direct child PIDs (space-separated)
  const content = readProcFile(`/proc/${pid}/task/${pid}/children`).trim();
  if (!content) return [];
  return content
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n) && n > 0);
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

const MACOS_MAX_CHILD_DEPTH = 3;

/**
 * Parse lsof tabular output.
 * Returns the first listening port, preferring loopback/any addresses.
 */
export function _parseMacosLsofOutput(output: string): number | null {
  const lines = output.split("\n");
  const fallbackCandidates: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) continue;

    const cols = trimmed.split(/\s+/);
    // lsof NAME column: "host:port (LISTEN)" — may appear as two separate tokens
    // when split by whitespace. Find the token that looks like "host:port".
    // Strategy: reconstruct the trailing portion after NODE column (index 8),
    // then strip "(LISTEN)".
    // Simpler: join the last 1-2 cols and strip the LISTEN annotation.
    const rawName = cols.slice(8).join(" ").replace(/\s*\(LISTEN\)\s*$/, "");
    // rawName is now "NODE host:port" — take the last token which is "host:port"
    const nameParts = rawName.trim().split(/\s+/);
    const name: string = nameParts[nameParts.length - 1] ?? "";
    if (!name) continue;
    const nameWithoutListen = name;
    const lastColon = nameWithoutListen.lastIndexOf(":");
    if (lastColon === -1) continue;

    const portStr = nameWithoutListen.slice(lastColon + 1);
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0) continue;

    const host = nameWithoutListen.slice(0, lastColon);
    // Prefer loopback / wildcard
    if (
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "*" ||
      host === "0.0.0.0" ||
      host === "::"
    ) {
      return port;
    }
    fallbackCandidates.push(port);
  }

  return fallbackCandidates.length > 0 ? (fallbackCandidates[0] ?? null) : null;
}

export function _macosReadListeningPort(pid: number, depth: number): number | null {
  if (depth > MACOS_MAX_CHILD_DEPTH) return null;

  const result = spawnSync({
    cmd: ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = result.stdout.toString();
  const port = _parseMacosLsofOutput(output);
  if (port !== null) return port;

  // Walk children via pgrep
  const children = _macosGetChildren(pid);
  for (const childPid of children) {
    const childPort = _macosReadListeningPort(childPid, depth + 1);
    if (childPort !== null) return childPort;
  }
  return null;
}

export function _macosGetChildren(pid: number): number[] {
  const result = spawnSync({
    cmd: ["pgrep", "-P", String(pid)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString().trim();
  if (!output) return [];
  return output
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

const WINDOWS_MAX_CHILD_DEPTH = 3;

/** Parse PowerShell Get-NetTCPConnection JSON output. */
export function _parseWindowsPowerShellOutput(json: string): number | null {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "null") return null;

  type PortObject = { LocalPort: unknown };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || parsed === undefined) return null;

    if (Array.isArray(parsed)) {
      for (const item of parsed as unknown[]) {
        if (item !== null && typeof item === "object" && "LocalPort" in (item as object)) {
          const port = Number((item as PortObject).LocalPort);
          if (!isNaN(port) && port > 0) return port;
        }
      }
      return null;
    }

    if (typeof parsed === "object" && parsed !== null && "LocalPort" in parsed) {
      const port = Number((parsed as PortObject).LocalPort);
      return !isNaN(port) && port > 0 ? port : null;
    }

    return null;
  } catch {
    return null;
  }
}

/** Parse netstat -ano tabular output for a given PID. */
export function _parseWindowsNetstatOutput(output: string, pid: number): number | null {
  // Columns: Proto  LocalAddress  ForeignAddress  State  PID
  // e.g.:    TCP    0.0.0.0:8080  0.0.0.0:0       LISTENING  1234
  const pidStr = String(pid);
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cols = trimmed.split(/\s+/);
    if (cols.length < 5) continue;

    const proto: string = (cols[0] ?? "").toUpperCase();
    const localAddr: string = cols[1] ?? "";
    const state: string = (cols[3] ?? "").toUpperCase();
    const linePid: string = cols[4] ?? "";

    if (proto !== "TCP" && proto !== "TCP6") continue;
    if (state !== "LISTENING") continue;
    if (linePid !== pidStr) continue;

    const lastColon = localAddr.lastIndexOf(":");
    if (lastColon === -1) continue;

    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (!isNaN(port) && port > 0) return port;
  }
  return null;
}

export function _windowsReadListeningPort(pid: number, depth: number): number | null {
  if (depth > WINDOWS_MAX_CHILD_DEPTH) return null;

  const psResult = spawnSync({
    cmd: [
      "powershell",
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = psResult.stderr.toString();
  const useFallback =
    !psResult.success ||
    stderr.includes("is not recognized") ||
    stderr.includes("CommandNotFoundException");

  if (!useFallback) {
    const port = _parseWindowsPowerShellOutput(psResult.stdout.toString());
    if (port !== null) return port;
  } else {
    // Fallback: netstat -ano | findstr <pid>
    const nsResult = spawnSync({
      cmd: ["cmd", "/c", `netstat -ano | findstr ${pid}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    const port = _parseWindowsNetstatOutput(nsResult.stdout.toString(), pid);
    if (port !== null) return port;
  }

  // Walk children
  const children = _windowsGetChildren(pid);
  for (const childPid of children) {
    const childPort = _windowsReadListeningPort(childPid, depth + 1);
    if (childPort !== null) return childPort;
  }
  return null;
}

export function _windowsGetChildren(pid: number): number[] {
  const psResult = spawnSync({
    cmd: [
      "powershell",
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object ProcessId | ConvertTo-Json`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = psResult.stderr.toString();
  const useFallback =
    !psResult.success ||
    stderr.includes("is not recognized") ||
    stderr.includes("CommandNotFoundException");

  if (!useFallback) {
    const output = psResult.stdout.toString().trim();
    if (!output || output === "null") return [];
    try {
      const parsed: unknown = JSON.parse(output);
      type PidObject = { ProcessId: unknown };
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .filter(
            (item): item is PidObject =>
              item !== null && typeof item === "object" && "ProcessId" in (item as object),
          )
          .map((item) => Number(item.ProcessId))
          .filter((n) => !isNaN(n) && n > 0);
      }
      if (typeof parsed === "object" && parsed !== null && "ProcessId" in parsed) {
        const id = Number((parsed as PidObject).ProcessId);
        return !isNaN(id) && id > 0 ? [id] : [];
      }
    } catch {
      // ignore
    }
    return [];
  }

  // Fallback: wmic
  const wmicResult = spawnSync({
    cmd: ["wmic", "process", "where", `(ParentProcessId=${pid})`, "get", "ProcessId"],
    stdout: "pipe",
    stderr: "pipe",
  });
  return wmicResult
    .stdout.toString()
    .split("\n")
    .slice(1) // skip header
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}
