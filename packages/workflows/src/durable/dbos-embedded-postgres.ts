/**
 * Embedded Postgres for DBOS workflow durability.
 *
 * When no `DBOS_SYSTEM_DATABASE_URL` is configured, Atomic runs DBOS against
 * its own Postgres instance built from npm-distributed binaries
 * (`@embedded-postgres/<platform>-<arch>`, installed as an optional dependency
 * of `embedded-postgres`). No Docker daemon or system Postgres is required.
 *
 * The cluster lives under `~/.atomic/postgres/v<major>` on a dedicated port and
 * is started with `pg_ctl`, which daemonizes the server into its own session.
 * It survives an abrupt Atomic exit and can be shared by concurrent sessions.
 * During orderly durable shutdown, Atomic stops only the cluster whose captured
 * postmaster PID still matches; an attached or replacement cluster is untouched.
 *
 * PostgreSQL refuses to run as UID 0, so a root Atomic process (containers,
 * CI sandboxes, eval harnesses) resolves an unprivileged system account, keeps
 * the cluster under `/var/lib/atomic-postgres` instead (a root home directory
 * is untraversable for that account), and runs every Postgres command with
 * dropped privileges. See dbos-embedded-postgres-root.ts.
 */

import {
	chmodSync,
	chownSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	type EmbeddedPostgresRunContext,
	prepareBinariesForOwner,
	resolveEmbeddedRunContext,
} from "./dbos-embedded-postgres-root.js";
import { commandFailureDetail, delay, runLocalCommand, tcpReachable } from "./local-command.js";

const EMBEDDED_HOST = "127.0.0.1";
const EMBEDDED_PORT = 5439;
const EMBEDDED_USER = "postgres";
const EMBEDDED_PASSWORD = "atomic";
const EMBEDDED_PG_MAJOR = 18;
const READY_ATTEMPTS = 120;
const READY_DELAY_MS = 250;
const SETUP_LOCK_STALE_MS = 120_000;

export const EMBEDDED_DBOS_SYSTEM_DATABASE_URL = `postgresql://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@${EMBEDDED_HOST}:${EMBEDDED_PORT}/atomic_workflows_dbos_sys?connect_timeout=10&sslmode=disable`;

interface EmbeddedPostgresBinaries {
	readonly pg_ctl: string;
	readonly initdb: string;
}
interface ActiveEmbeddedPostgres {
	readonly pgCtl: string;
	readonly dataDir: string;
	readonly context: EmbeddedPostgresRunContext;
	/** PID read after this process successfully started the cluster. */
	readonly postgresPid: number;
	/** OS process-instance token captured with postgresPid. */
	readonly postgresIdentity: string;
}

type ProcessIdentityReader = (pid: number) => Promise<string | undefined>;

let activeCluster: ActiveEmbeddedPostgres | undefined;
let processIdentityReader: ProcessIdentityReader = readProcessIdentity;

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
	let startedHere = false;

	await withSetupLock(join(root, `v${EMBEDDED_PG_MAJOR}.setup-lock`), async () => {
		if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
		if (!existsSync(join(dataDir, "PG_VERSION"))) await initializeCluster(binaries.initdb, dataDir, context);
		startedHere = await startCluster(binaries.pg_ctl, dataDir, logFile, context);
	});

	for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
		if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) {
			if (startedHere) {
				const postgresPid = readPostgresPid(dataDir);
				if (postgresPid === undefined)
					throw new Error(`Embedded Postgres became reachable without a postmaster.pid at ${dataDir}.`);
				const postgresIdentity = await processIdentityReader(postgresPid);
				// A numeric PID is not durable ownership: the OS can reuse it after
				// the postmaster exits. If its process instance cannot be identified,
				// leave the shared cluster running rather than risk stopping a stranger.
				if (postgresIdentity !== undefined) {
					activeCluster = { pgCtl: binaries.pg_ctl, dataDir, context, postgresPid, postgresIdentity };
				}
			}
			return;
		}
		await delay(READY_DELAY_MS);
	}
	throw new Error(
		`Embedded Postgres started but never accepted connections on ${EMBEDDED_HOST}:${EMBEDDED_PORT}; see ${logFile}.`,
	);
}

/** Stop the cluster started by this process while its process identity remains owned. */
export async function shutdownEmbeddedDbosPostgres(): Promise<void> {
	const cluster = activeCluster;
	activeCluster = undefined;
	if (cluster === undefined) return;
	// PID, pidfile, and OS process-instance identity must all still match
	// immediately before pg_ctl can signal the postmaster.
	if (!(await clusterStillRunning(cluster.dataDir, cluster.postgresPid, cluster.postgresIdentity))) return;

	const result = await cluster.context.runAsOwner(cluster.pgCtl, [
		"-D",
		cluster.dataDir,
		"-m",
		"fast",
		"-w",
		"-t",
		"60",
		"stop",
	]);
	if (
		result.exitCode !== 0 &&
		(await clusterStillRunning(cluster.dataDir, cluster.postgresPid, cluster.postgresIdentity))
	) {
		throw new Error(
			`Could not stop the embedded Postgres cluster: ${commandFailureDetail(result)}${logTail(join(cluster.context.baseDir, `v${EMBEDDED_PG_MAJOR}.log`))}`,
		);
	}
	while (await clusterStillRunning(cluster.dataDir, cluster.postgresPid, cluster.postgresIdentity)) {
		await delay(READY_DELAY_MS);
	}
}

async function clusterStillRunning(dataDir: string, expectedPid: number, expectedIdentity: string): Promise<boolean> {
	const pid = readPostgresPid(dataDir);
	if (pid !== expectedPid) return false;
	return (await processIdentityReader(expectedPid)) === expectedIdentity;
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") return readLinuxProcessIdentity(pid);
	if (process.platform === "win32") {
		const result = await runLocalCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
		]).catch(() => undefined);
		const startTime = result?.exitCode === 0 ? result.stdout.trim() : "";
		return startTime === "" ? undefined : `win32:${startTime}`;
	}
	if (["aix", "darwin", "freebsd", "netbsd", "openbsd", "sunos"].includes(process.platform)) {
		const result = await runLocalCommand("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)]).catch(
			() => undefined,
		);
		const startTime = result?.exitCode === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
		return startTime === "" ? undefined : `${process.platform}:${startTime}`;
	}
	return undefined;
}

function readLinuxProcessIdentity(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0) return undefined;
		// Fields after the command begin with field 3 (state); starttime is field 22.
		const startTime = stat
			.slice(commandEnd + 1)
			.trim()
			.split(/\s+/)[19];
		return startTime === undefined || !/^\d+$/.test(startTime) ? undefined : `linux:${startTime}`;
	} catch {
		return undefined;
	}
}

function readPostgresPid(dataDir: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n", 1)[0] ?? "", 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}
async function initializeCluster(initdb: string, dataDir: string, context: EmbeddedPostgresRunContext): Promise<void> {
	const passwordFile = join(tmpdir(), `atomic-pg-pw-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
	writeFileSync(passwordFile, `${EMBEDDED_PASSWORD}\n`, { mode: 0o600 });
	try {
		if (context.owner !== undefined) chownSync(passwordFile, context.owner.uid, context.owner.gid);
		const result = await context.runAsOwner(initdb, [
			"-D",
			dataDir,
			"-U",
			EMBEDDED_USER,
			"-A",
			"password",
			`--pwfile=${passwordFile}`,
			"-E",
			"UTF8",
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
	isReachable: typeof tcpReachable = tcpReachable,
): Promise<boolean> {
	const result = await context.runAsOwner(
		pgCtl,
		[
			"-D",
			dataDir,
			"-l",
			logFile,
			"-o",
			`-p ${EMBEDDED_PORT} -c listen_addresses=${EMBEDDED_HOST}`,
			"-w",
			"-t",
			"60",
			"start",
		],
		{ completion: "successful-exit" },
	);
	if (result.exitCode === 0) return true;
	// Another instance can become reachable while pg_ctl runs. Attach to it,
	// but do not claim ownership of a postmaster this command did not start.
	if (await isReachable(EMBEDDED_HOST, EMBEDDED_PORT, 3_000)) return false;
	throw new Error(`Could not start the embedded Postgres cluster: ${commandFailureDetail(result)}${logTail(logFile)}`);
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
		binaries = (await import(packageName)) as Partial<EmbeddedPostgresBinaries>;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Embedded Postgres binaries are unavailable for ${process.platform}/${process.arch} (${packageName}): ${detail}`,
		);
	}
	if (typeof binaries.pg_ctl !== "string" || typeof binaries.initdb !== "string") {
		throw new Error(`Embedded Postgres package ${packageName} did not export pg_ctl/initdb paths.`);
	}
	for (const binary of [
		binaries.pg_ctl,
		binaries.initdb,
		join(dirname(binaries.pg_ctl), process.platform === "win32" ? "postgres.exe" : "postgres"),
	]) {
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
			if (attempt === READY_ATTEMPTS - 1)
				throw new Error(`Timed out waiting for another Atomic process to finish Postgres setup (${lockDir}).`);
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
function setActiveClusterForTests(
	pgCtl: string | undefined,
	dataDir?: string,
	context?: EmbeddedPostgresRunContext,
	postgresPid?: number,
	postgresIdentity?: string,
): void {
	if (pgCtl === undefined) {
		activeCluster = undefined;
		return;
	}
	if (dataDir === undefined || context === undefined || postgresPid === undefined || postgresIdentity === undefined) {
		throw new Error(
			"An active embedded Postgres test cluster requires its data directory, context, PID, and identity.",
		);
	}
	activeCluster = { pgCtl, dataDir, context, postgresPid, postgresIdentity };
}

function setProcessIdentityReaderForTests(reader: ProcessIdentityReader | undefined): void {
	processIdentityReader = reader ?? readProcessIdentity;
}

/** Narrow seams for command-boundary and process-ownership tests. */
export const embeddedPostgresTestHooks = {
	clusterStillRunning,
	readProcessIdentity,
	setActiveCluster: setActiveClusterForTests,
	setProcessIdentityReader: setProcessIdentityReaderForTests,
	startCluster,
};

export function resetEmbeddedDbosPostgresForTests(): void {
	ensured = undefined;
	activeCluster = undefined;
	processIdentityReader = readProcessIdentity;
}
