import { spawnSync } from "child_process";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "fs";
import { join } from "path";

/**
 * Whether no process has the file at `path` open, proven by the operating system (#5220). A lock or record is created
 * and then written in one call that holds the file open throughout, so one found empty or part-written while no process
 * has it open was left by a process that died while writing it, whatever its age: a time grace cannot tell a writer
 * that stalled from one that died, as on FAT, whose times are kept to two seconds, or under a long pause.
 *
 * False whenever that cannot be proven: the file is someone else's, a process that may hold it cannot be inspected, or
 * the platform offers no way to tell. A false answer only makes the caller wait.
 *
 * Linux: the descriptors of every process of this user, in `/proc`. Windows: an open that shares nothing, which fails
 * while any other handle is open (libuv's `UV_FS_O_EXLOCK` under Node; a .NET `FileShare.None` open elsewhere, as Bun
 * ignores the flag). macOS: `lsof`.
 */
export function noProcessHasOpen(path: string): boolean {
  let uid: number;
  try {
    uid = statSync(path).uid;
  } catch {
    return false;
  }
  if (process.platform === "win32") return windowsNoneOpen(path);
  if (typeof process.getuid === "function" && uid !== process.getuid()) return false;
  if (process.platform === "linux") return linuxNoneOpen(path, uid);
  if (process.platform === "darwin") return lsofNoneOpen(path);
  return false;
}

/** libuv's exclusive-sharing open flag on Windows, which Node passes through as a numeric open flag. */
const UV_FS_O_EXLOCK = 0x10000000;

/** How long a platform tool asked whether a file is open may take before the answer counts as unknown. */
const TOOL_TIMEOUT_MS = 5_000;

function windowsNoneOpen(path: string): boolean {
  if (process.versions.bun === undefined) {
    try {
      closeSync(openSync(path, UV_FS_O_EXLOCK));
      return true;
    } catch {
      return false;
    }
  }
  const literal = `'${path.replace(/'/g, "''")}'`;
  const script = `try { $f = [System.IO.File]::Open(${literal}, 'Open', 'Read', 'None'); $f.Close(); 'closed' } catch { 'open' }`;
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim() === "closed";
}

/**
 * Whether the process `pid`, whose descriptors cannot be read (one made non-dumpable), may hold one of Intercom's
 * files: it is not a zombie, which holds none, and its name or command line is not one of a process that never writes
 * them, as `ssh-agent` or `gpg-agent`. Unknown counts as may.
 */
function mayHoldIntercomFiles(pid: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return /node|bun|atomic|intercom|jiti/i.test(`${name}\0${cmdline}`) || (cmdline === "" && name === "");
  } catch {
    return true;
  }
}

function linuxNoneOpen(path: string, uid: number): boolean {
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return false;
  }
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }
  for (const pid of pids) {
    let owner: number;
    try {
      owner = statSync(`/proc/${pid}`).uid;
    } catch {
      continue; // Gone meanwhile.
    }
    if (owner !== uid) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A process of this user whose descriptors cannot be read (one made non-dumpable): it may hold the file, unless
      // it is no process that writes Intercom's files.
      if (mayHoldIntercomFiles(pid)) return false;
      continue;
    }
    for (const fd of descriptors) {
      try {
        if (readlinkSync(join(`/proc/${pid}/fd`, fd)) === target) return false;
      } catch {
        // Closed meanwhile.
      }
    }
  }
  return true;
}

function lsofNoneOpen(path: string): boolean {
  const result = spawnSync("lsof", ["-t", "--", path], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  // lsof exits 1 with nothing printed when no process has the file open, and also on its own errors, which print.
  return result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "";
}
