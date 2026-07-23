/**
 * Embedded Postgres for DBOS workflow durability.
 *
 * When no `DBOS_SYSTEM_DATABASE_URL` is configured, Atomic runs DBOS against
 * its own Postgres instance built from npm-distributed binaries
 * (`@embedded-postgres/<platform>-<arch>`, installed as an optional dependency
 * of `embedded-postgres`). No Docker daemon or system Postgres is required.
 *
 * The cluster lives under `~/.atomic/postgres/v<major>` on a dedicated port and
 * is started with `pg_ctl`, which daemonizes the server into its own session:
 * it survives Atomic exiting and is shared by every concurrent Atomic session.
 * Atomic never stops it.
 *
 * PostgreSQL refuses to run as UID 0, so a root Atomic process (containers,
 * CI sandboxes, eval harnesses) resolves an unprivileged system account, keeps
 * the cluster under `/var/lib/atomic-postgres` instead (a root home directory
 * is untraversable for that account), and runs every Postgres command with
 * dropped privileges. See dbos-embedded-postgres-root.ts.
 */

import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  prepareBinariesForOwner,
  resolveEmbeddedRunContext,
  type EmbeddedPostgresRunContext,
} from "./dbos-embedded-postgres-root.js";
import { commandFailureDetail, delay, tcpReachable } from "./local-command.js";

const EMBEDDED_HOST = "127.0.0.1";
const EMBEDDED_PORT = 5439;
const EMBEDDED_USER = "postgres";
const EMBEDDED_PASSWORD = "atomic";
const EMBEDDED_PG_MAJOR = 18;
const READY_ATTEMPTS = 120;
const READY_DELAY_MS = 250;
const SETUP_LOCK_STALE_MS = 120_000;

export const EMBEDDED_DBOS_SYSTEM_DATABASE_URL =
  `postgresql://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@${EMBEDDED_HOST}:${EMBEDDED_PORT}/atomic_workflows_dbos_sys?connect_timeout=10&sslmode=disable`;

interface EmbeddedPostgresBinaries {
  readonly pg_ctl: string;
  readonly initdb: string;
}

let ensured: Promise<void> | undefined;

/** Start or attach to the shared embedded DBOS Postgres exactly once per process. */
export function ensureEmbeddedDbosPostgres(): Promise<void> {
  ensured ??= ensure().catch((error: unknown) => {
    ensured = undefined;
    throw error;
  });
  return ensured;
}

async function ensure(): Promise<void> {
  if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
  const loaded = await loadEmbeddedPostgresBinaries();
  hydrateBinaryLibraryLinks(loaded.pg_ctl);
  const context = await resolveEmbeddedRunContext();
  const root = context.baseDir;
  const dataDir = join(root, `v${EMBEDDED_PG_MAJOR}`);
  const logFile = join(root, `v${EMBEDDED_PG_MAJOR}.log`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (context.owner !== undefined) chownSync(root, context.owner.uid, context.owner.gid);
  const binaries = await prepareBinariesForOwner(loaded, context);

  await withSetupLock(join(root, `v${EMBEDDED_PG_MAJOR}.setup-lock`), async () => {
    if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
    if (!existsSync(join(dataDir, "PG_VERSION"))) await initializeCluster(binaries.initdb, dataDir, context);
    await startCluster(binaries.pg_ctl, dataDir, logFile, context);
  });

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
    await delay(READY_DELAY_MS);
  }
  throw new Error(`Embedded Postgres started but never accepted connections on ${EMBEDDED_HOST}:${EMBEDDED_PORT}; see ${logFile}.`);
}

async function initializeCluster(
  initdb: string,
  dataDir: string,
  context: EmbeddedPostgresRunContext,
): Promise<void> {
  const passwordFile = join(tmpdir(), `atomic-pg-pw-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  writeFileSync(passwordFile, `${EMBEDDED_PASSWORD}\n`, { mode: 0o600 });
  try {
    if (context.owner !== undefined) chownSync(passwordFile, context.owner.uid, context.owner.gid);
    const result = await context.runAsOwner(initdb, [
      "-D", dataDir,
      "-U", EMBEDDED_USER,
      "-A", "password",
      `--pwfile=${passwordFile}`,
      "-E", "UTF8",
      "--no-locale",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Could not initialize the embedded Postgres cluster: ${commandFailureDetail(result)}`);
    }
  } finally {
    rmSync(passwordFile, { force: true });
  }
}

async function startCluster(
  pgCtl: string,
  dataDir: string,
  logFile: string,
  context: EmbeddedPostgresRunContext,
): Promise<void> {
  const result = await context.runAsOwner(pgCtl, [
    "-D", dataDir,
    "-l", logFile,
    "-o", `-p ${EMBEDDED_PORT} -c listen_addresses=${EMBEDDED_HOST}`,
    "-w", "-t", "60",
    "start",
  ]);
  if (result.exitCode === 0) return;
  // A concurrent session may have won the start race; readiness polling in the
  // caller decides. Only fail here when nothing is coming up on the port.
  if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT, 3_000)) return;
  throw new Error(
    `Could not start the embedded Postgres cluster: ${commandFailureDetail(result)}${logTail(logFile)}`,
  );
}

/**
 * The npm platform packages ship `native/lib` symlinks (e.g.
 * `libicudata.dylib → libicudata.77.1.dylib`) through a `pg-symlinks.json`
 * manifest plus a postinstall script, because npm tarballs cannot contain
 * symlinks. Bun and `--ignore-scripts` installs skip postinstall, so hydrate
 * the links at runtime; fall back to copying when symlinks are unavailable.
 */
function hydrateBinaryLibraryLinks(pgCtlPath: string): void {
  const packageRoot = dirname(dirname(dirname(pgCtlPath)));
  let manifest: readonly { readonly source: string; readonly target: string }[];
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "native", "pg-symlinks.json"), "utf8")) as typeof manifest;
  } catch {
    return;
  }
  for (const { source, target } of manifest) {
    const absoluteSource = join(packageRoot, source);
    const absoluteTarget = join(packageRoot, target);
    if (existsSync(absoluteTarget) || !existsSync(absoluteSource)) continue;
    try {
      symlinkSync(relative(dirname(absoluteTarget), absoluteSource), absoluteTarget);
    } catch {
      try {
        copyFileSync(absoluteSource, absoluteTarget);
      } catch {
        // Missing optional libraries surface as an initdb/pg_ctl failure with detail.
      }
    }
  }
}

async function loadEmbeddedPostgresBinaries(): Promise<EmbeddedPostgresBinaries> {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const packageName = `@embedded-postgres/${platform}-${process.arch}`;
  let binaries: Partial<EmbeddedPostgresBinaries>;
  try {
    binaries = await import(packageName) as Partial<EmbeddedPostgresBinaries>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Embedded Postgres binaries are unavailable for ${process.platform}/${process.arch} (${packageName}): ${detail}`);
  }
  if (typeof binaries.pg_ctl !== "string" || typeof binaries.initdb !== "string") {
    throw new Error(`Embedded Postgres package ${packageName} did not export pg_ctl/initdb paths.`);
  }
  for (const binary of [binaries.pg_ctl, binaries.initdb, join(dirname(binaries.pg_ctl), process.platform === "win32" ? "postgres.exe" : "postgres")]) {
    ensureExecutable(binary);
  }
  return { pg_ctl: binaries.pg_ctl, initdb: binaries.initdb };
}

/** npm can strip executable bits; restore them only when actually missing. */
function ensureExecutable(filePath: string): void {
  try {
    const mode = statSync(filePath).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(filePath, mode | 0o555);
  } catch {
    // A genuinely missing binary surfaces as a spawn failure with detail.
  }
}

/** Serialize initdb/start across concurrent Atomic processes on this machine. */
async function withSetupLock(lockDir: string, fn: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (lockIsStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await delay(READY_DELAY_MS);
      if (attempt === READY_ATTEMPTS - 1) throw new Error(`Timed out waiting for another Atomic process to finish Postgres setup (${lockDir}).`);
    }
  }
  try {
    await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
function lockIsStale(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > SETUP_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function logTail(logFile: string): string {
  try {
    const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
    return `\nPostgres log tail:\n${lines.slice(-5).join("\n")}`;
  } catch {
    return "";
  }
}

export function resetEmbeddedDbosPostgresForTests(): void {
  ensured = undefined;
}
