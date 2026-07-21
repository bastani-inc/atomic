/**
 * Root-execution support for the embedded DBOS Postgres.
 *
 * PostgreSQL categorically refuses to run `initdb`/`postgres` as UID 0, so a
 * root Atomic process (common in containers, CI sandboxes, and eval harnesses)
 * cannot provision the embedded cluster directly. On Linux we instead resolve
 * an unprivileged system account, keep the cluster under a root-safe base
 * directory (`/root` is mode 0700 and untraversable by that account), and run
 * every Postgres command with dropped privileges.
 *
 * Privilege dropping is strategy-probed at runtime: Node honors the child
 * process `uid`/`gid` spawn options, but Bun currently ignores them, so we
 * verify the drop actually happens (`id -u` must report the owner) and fall
 * back to `setpriv`, `runuser`, or `su` wrappers when it does not.
 *
 * The embedded binaries themselves may also live under an untraversable
 * prefix (for example a root-owned `~/.nvm` global install), so the caller can
 * probe them as the unprivileged owner and fall back to a one-time copy into
 * the cluster base directory.
 */

import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runLocalCommand, type LocalCommandResult } from "./local-command.js";

export interface EmbeddedPostgresOwner {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
}

export interface EmbeddedPostgresRunContext {
  /** Directory that holds the cluster, log file, and setup locks. */
  readonly baseDir: string;
  /** Present only when commands must drop privileges (Linux root). */
  readonly owner?: EmbeddedPostgresOwner;
  /** Runs a command as the owner; identity pass-through when no owner. */
  readonly runAsOwner: LocalCommandRunner;
}

export interface EmbeddedPostgresBinaryPaths {
  readonly pg_ctl: string;
  readonly initdb: string;
}

export type LocalCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly uid?: number; readonly gid?: number },
) => Promise<LocalCommandResult>;

/** Root-safe cluster location: system path, traversable by system accounts. */
export const ROOT_EMBEDDED_BASE_DIR = "/var/lib/atomic-postgres";

/** Unprivileged accounts tried in order; `postgres` wins when present. */
const OWNER_CANDIDATES = ["postgres", "nobody", "daemon"] as const;

export function defaultEmbeddedBaseDir(): string {
  return join(homedir(), ".atomic", "postgres");
}

/**
 * Resolve where and as whom the embedded cluster should run. Non-root (and
 * every non-Linux platform) keeps the historical home-directory layout. Linux
 * root without a resolvable unprivileged account, or without any working
 * privilege-drop mechanism, also falls through to the default context so
 * PostgreSQL's own root refusal surfaces with full detail.
 */
export async function resolveEmbeddedRunContext(
  runner: LocalCommandRunner = runLocalCommand,
  euid: number | undefined = process.getuid?.(),
  platform: NodeJS.Platform = process.platform,
): Promise<EmbeddedPostgresRunContext> {
  if (platform !== "linux" || euid !== 0) {
    return { baseDir: defaultEmbeddedBaseDir(), runAsOwner: runner };
  }
  for (const name of OWNER_CANDIDATES) {
    const owner = await lookupOwner(runner, name);
    if (owner === undefined) continue;
    const runAsOwner = await resolvePrivilegeDrop(runner, owner);
    if (runAsOwner === undefined) continue;
    return { baseDir: ROOT_EMBEDDED_BASE_DIR, owner, runAsOwner };
  }
  return { baseDir: defaultEmbeddedBaseDir(), runAsOwner: runner };
}

/**
 * Return a runner that verifiably executes commands as the owner, or
 * `undefined` when no drop mechanism works. Each strategy is validated by
 * running `id -u` through it and requiring the owner's uid on stdout — the
 * spawn `uid`/`gid` options in particular are silently ignored by Bun.
 */
export async function resolvePrivilegeDrop(
  runner: LocalCommandRunner,
  owner: EmbeddedPostgresOwner,
): Promise<LocalCommandRunner | undefined> {
  const strategies: readonly LocalCommandRunner[] = [
    (command, args) => runner(command, args, { uid: owner.uid, gid: owner.gid }),
    (command, args) => runner("setpriv", [
      `--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", "--", command, ...args,
    ]),
    (command, args) => runner("runuser", ["-u", owner.name, "--", command, ...args]),
    (command, args) => runner("su", ["-s", "/bin/sh", "-c", shellCommand(command, args), owner.name]),
  ];
  for (const strategy of strategies) {
    const probe = await strategy("id", ["-u"]).catch(() => undefined);
    if (probe !== undefined && probe.exitCode === 0 && probe.stdout.trim() === String(owner.uid)) {
      return strategy;
    }
  }
  return undefined;
}

/**
 * Ensure the embedded binaries are executable by the drop-privilege owner.
 * Probes `initdb --version` as the owner; on failure (typically an
 * untraversable ancestor such as `/root`) copies the package's `native` tree
 * into the cluster base directory once and reuses it afterwards.
 */
export async function prepareBinariesForOwner(
  binaries: EmbeddedPostgresBinaryPaths,
  context: EmbeddedPostgresRunContext,
  runner: LocalCommandRunner = runLocalCommand,
): Promise<EmbeddedPostgresBinaryPaths> {
  const owner = context.owner;
  if (owner === undefined) return binaries;

  const probe = await context.runAsOwner(binaries.initdb, ["--version"]).catch(() => undefined);
  if (probe !== undefined && probe.exitCode === 0) return binaries;

  // `<packageRoot>/native/bin/initdb` → copy the whole `native` tree so the
  // binaries keep their relative `../lib` runtime library references.
  const nativeDir = dirname(dirname(binaries.initdb));
  const copiedNativeDir = join(context.baseDir, "pg-runtime", "native");
  const copied: EmbeddedPostgresBinaryPaths = {
    pg_ctl: join(copiedNativeDir, "bin", "pg_ctl"),
    initdb: join(copiedNativeDir, "bin", "initdb"),
  };
  if (!existsSync(copied.initdb)) {
    cpSync(nativeDir, copiedNativeDir, { recursive: true });
  }
  const chown = await runner("chown", ["-R", `${owner.uid}:${owner.gid}`, join(context.baseDir, "pg-runtime")]);
  if (chown.exitCode !== 0) {
    throw new Error(
      `Could not hand the copied embedded Postgres runtime to ${owner.name}: ${chown.stderr.trim() || chown.stdout.trim() || `exit ${chown.exitCode}`}`,
    );
  }
  return copied;
}

async function lookupOwner(runner: LocalCommandRunner, name: string): Promise<EmbeddedPostgresOwner | undefined> {
  const uid = await lookupId(runner, ["-u", name]);
  const gid = await lookupId(runner, ["-g", name]);
  if (uid === undefined || gid === undefined || uid === 0) return undefined;
  return { uid, gid, name };
}

async function lookupId(runner: LocalCommandRunner, args: readonly string[]): Promise<number | undefined> {
  try {
    const result = await runner("id", args);
    if (result.exitCode !== 0) return undefined;
    const value = Number.parseInt(result.stdout.trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Single-quote a command line for `su -c`; arguments never embed user input. */
function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}
