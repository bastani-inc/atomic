/**
 * Embedded Postgres for DBOS workflow durability.
 *
 * When no `DBOS_SYSTEM_DATABASE_URL` is configured, Atomic runs DBOS against
 * its own Postgres instance built from npm-distributed binaries
 * (`@embedded-postgres/<platform>-<arch>`, installed as an optional dependency
 * of `embedded-postgres`). No Docker daemon or system Postgres is required.
 *
 * The cluster lives under `~/.atomic/postgres/v<major>` on a dedicated port.
 * Atomic starts Postgres directly and retains an opaque native process lease;
 * releasing that lease does not kill the server, so it survives abrupt exits
 * and can be shared by concurrent sessions. Orderly shutdown signals and waits
 * on that exact retained process instance; attached clusters are untouched.
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
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, uptime } from "node:os";
import { dirname, join, relative } from "node:path";
import type { RetainedPostgres, RetainedPostgresSpawnOptions } from "@bastani/atomic-natives";
import {
	cleanupAbandonedRuntimeStages,
	type EmbeddedPostgresRunContext,
	prepareBinariesForOwner,
	type RuntimePublicationLease,
	resolveEmbeddedRunContext,
} from "./dbos-embedded-postgres-root.js";
import {
	detectCurrentHostLibc,
	type EmbeddedPostgresHost,
	resolveEmbeddedPostgresTarget,
} from "./dbos-embedded-postgres-targets.js";
import { commandFailureDetail, delay, tcpReachable } from "./local-command.js";

const EMBEDDED_HOST = "127.0.0.1";
const EMBEDDED_PORT = 5439;
const EMBEDDED_USER = "postgres";
const EMBEDDED_PASSWORD = "atomic";
const EMBEDDED_PG_MAJOR = 18;
const READY_ATTEMPTS = 120;
const READY_DELAY_MS = 250;
const SETUP_LOCK_STALE_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;

export const EMBEDDED_DBOS_SYSTEM_DATABASE_URL = `postgresql://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@${EMBEDDED_HOST}:${EMBEDDED_PORT}/atomic_workflows_dbos_sys?connect_timeout=10&sslmode=disable`;

interface EmbeddedPostgresBinaries {
	readonly pg_ctl: string;
	readonly initdb: string;
	readonly postgres: string;
}

type RetainedPostgresSpawner = (options: RetainedPostgresSpawnOptions) => RetainedPostgres;

interface ActiveEmbeddedPostgres {
	readonly lease: RetainedPostgres;
	stopPromise?: Promise<void>;
}

type EnsureOperation = () => Promise<void>;
type ReachabilityProbe = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
type DelayOperation = (milliseconds: number) => Promise<void>;

export class EmbeddedPostgresCleanupPendingError extends AggregateError {
	constructor(errors: readonly unknown[], message: string) {
		super(errors, message);
		this.name = "EmbeddedPostgresCleanupPendingError";
	}
}

let activeCluster: ActiveEmbeddedPostgres | undefined;
let ensureOperation: EnsureOperation = ensure;
let retainedPostgresSpawnerOverride: RetainedPostgresSpawner | undefined;

let ensured: Promise<void> | undefined;

/** Start or attach to the shared embedded DBOS Postgres exactly once per process. */
export function ensureEmbeddedDbosPostgres(): Promise<void> {
	if (ensured === undefined && activeCluster !== undefined) {
		return Promise.reject(
			new EmbeddedPostgresCleanupPendingError(
				[],
				"Embedded Postgres startup is blocked while retained Postgres cleanup is pending; retry shutdown first.",
			),
		);
	}
	ensured ??= ensureOperation().catch((error: unknown) => {
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
	mkdirSync(root, { recursive: true, mode: context.owner === undefined ? 0o700 : 0o755 });
	if (context.owner !== undefined) {
		// Keep every ancestor of published runtime generations root-owned. The
		// data directory itself is handed to Postgres during initialization.
		chownSync(root, 0, 0);
		chmodSync(root, 0o755);
	}
	let startedCluster: ActiveEmbeddedPostgres | undefined;
	try {
		await withSetupLock(join(root, `v${EMBEDDED_PG_MAJOR}.setup-lock`), async (setup) => {
			await cleanupAbandonedRuntimeStages(root, setup.abandonedRuntimeStageOwnerTokens);
			if (await tcpReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
			const binaries = await prepareBinariesForOwner(loaded, context, undefined, {
				publicationLease: setup.runtimePublicationLease,
			});
			if (!existsSync(join(dataDir, "PG_VERSION"))) await initializeCluster(binaries.initdb, dataDir, context);
			const lease = await startCluster(binaries.postgres, dataDir, logFile, context);
			if (lease !== undefined) {
				startedCluster = { lease };
				activeCluster = startedCluster;
			}
		});
	} catch (startupError) {
		await rollbackStartedCluster(startedCluster, startupError);
	}
	await waitForClusterReadiness(logFile, startedCluster);
}

async function rollbackStartedCluster(
	cluster: ActiveEmbeddedPostgres | undefined,
	startupError: unknown,
): Promise<never> {
	if (cluster !== undefined && activeCluster === cluster) {
		try {
			await shutdownEmbeddedDbosPostgres();
		} catch (cleanupError) {
			throw new EmbeddedPostgresCleanupPendingError(
				[startupError, cleanupError],
				"Embedded Postgres startup failed and its retained process could not be stopped.",
			);
		}
	}
	throw startupError;
}
async function waitForClusterReadiness(
	logFile: string,
	rollbackCluster: ActiveEmbeddedPostgres | undefined,
	isReachable: ReachabilityProbe = tcpReachable,
	attempts = READY_ATTEMPTS,
	wait: DelayOperation = delay,
): Promise<void> {
	try {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (await isReachable(EMBEDDED_HOST, EMBEDDED_PORT)) return;
			await wait(READY_DELAY_MS);
		}
		throw new Error(
			`Embedded Postgres started but never accepted connections on ${EMBEDDED_HOST}:${EMBEDDED_PORT}; see ${logFile}.`,
		);
	} catch (startupError) {
		await rollbackStartedCluster(rollbackCluster, startupError);
	}
}

/** Stop only the exact native process lease started by this Atomic process. */
export function shutdownEmbeddedDbosPostgres(): Promise<void> {
	const cluster = activeCluster;
	if (cluster === undefined) return Promise.resolve();
	cluster.stopPromise ??= stopActiveCluster(cluster);
	return cluster.stopPromise;
}

async function stopActiveCluster(cluster: ActiveEmbeddedPostgres): Promise<void> {
	try {
		await cluster.lease.interruptAndWait(SHUTDOWN_TIMEOUT_MS);
		cluster.lease.release();
		if (activeCluster === cluster) activeCluster = undefined;
	} catch (error) {
		// Timeout or signaling failure retains this exact native lease so a later
		// orderly-shutdown attempt can retry without reconstructing ownership.
		cluster.stopPromise = undefined;
		throw error;
	}
}

async function initializeCluster(initdb: string, dataDir: string, context: EmbeddedPostgresRunContext): Promise<void> {
	if (context.owner !== undefined) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		chownSync(dataDir, context.owner.uid, context.owner.gid);
		chmodSync(dataDir, 0o700);
	}
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
	postgres: string,
	dataDir: string,
	logFile: string,
	context: EmbeddedPostgresRunContext,
	isReachable: ReachabilityProbe = tcpReachable,
): Promise<RetainedPostgres | undefined> {
	try {
		return retainedPostgresSpawner()({
			executable: postgres,
			args: ["-D", dataDir, "-p", String(EMBEDDED_PORT), "-c", `listen_addresses=${EMBEDDED_HOST}`],
			cwd: dataDir,
			logFile,
			...(context.owner === undefined ? {} : { uid: context.owner.uid, gid: context.owner.gid }),
		});
	} catch (error) {
		// Another process can win the port while the setup lock is held. Attach to
		// it, but never manufacture an ownership lease from postmaster.pid.
		if (await isReachable(EMBEDDED_HOST, EMBEDDED_PORT, 3_000)) return undefined;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not start the embedded Postgres cluster: ${detail}${logTail(logFile)}`);
	}
}

function retainedPostgresSpawner(): RetainedPostgresSpawner {
	if (retainedPostgresSpawnerOverride !== undefined) return retainedPostgresSpawnerOverride;
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		readonly spawnRetainedPostgres: RetainedPostgresSpawner;
	};
	return binding.spawnRetainedPostgres;
}

/**
 * npm tarballs cannot contain symlinks. Runtime staging records each link in
 * `pg-symlinks.json`; recreate it on first use and copy as a last resort on
 * filesystems that do not permit symlinks.
 */
export function hydrateBinaryLibraryLinks(
	pgCtlPath: string,
	createLink: typeof symlinkSync = symlinkSync,
	copyFile: typeof copyFileSync = copyFileSync,
): void {
	let current = dirname(pgCtlPath);
	let manifestPath: string | undefined;
	let manifestRoot: string | undefined;
	for (let depth = 0; depth < 5; depth += 1) {
		const directManifest = join(current, "pg-symlinks.json");
		const nativeManifest = join(current, "native", "pg-symlinks.json");
		if (existsSync(directManifest)) {
			manifestPath = directManifest;
			manifestRoot = current;
			break;
		}
		if (existsSync(nativeManifest)) {
			manifestPath = nativeManifest;
			manifestRoot = current;
			break;
		}
		current = dirname(current);
	}
	if (manifestPath === undefined || manifestRoot === undefined) return;
	let manifest: readonly { readonly source: string; readonly target: string }[];
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
	} catch {
		return;
	}
	const firstSource = manifest[0]?.source;
	if (
		firstSource !== undefined &&
		!existsSync(join(manifestRoot, firstSource)) &&
		existsSync(join(dirname(manifestRoot), firstSource))
	) {
		manifestRoot = dirname(manifestRoot);
	}
	for (const { source, target } of manifest) {
		const absoluteSource = join(manifestRoot, source);
		const absoluteTarget = join(manifestRoot, target);
		if (existsSync(absoluteTarget) || !existsSync(absoluteSource)) continue;
		try {
			createLink(relative(dirname(absoluteTarget), absoluteSource), absoluteTarget);
		} catch {
			try {
				copyFile(absoluteSource, absoluteTarget);
			} catch {
				// Missing optional libraries surface as an initdb/Postgres failure with detail.
			}
		}
	}
}

type PackageResolver = (specifier: string) => string;
type PackageImporter = (specifier: string) => Promise<Partial<EmbeddedPostgresBinaries>>;

interface EmbeddedPostgresLoadOptions {
	readonly host?: EmbeddedPostgresHost;
	readonly runtimeDirectory?: string;
	readonly moduleUrl?: string;
	readonly resolvePackage?: PackageResolver;
	readonly importPackage?: PackageImporter;
}

function binariesFromDirectory(runtimeDirectory: string, platform: NodeJS.Platform): EmbeddedPostgresBinaries {
	const executableSuffix = platform === "win32" ? ".exe" : "";
	const binaries = {
		pg_ctl: join(runtimeDirectory, "bin", `pg_ctl${executableSuffix}`),
		initdb: join(runtimeDirectory, "bin", `initdb${executableSuffix}`),
		postgres: join(runtimeDirectory, "bin", `postgres${executableSuffix}`),
	};
	for (const [name, binary] of Object.entries(binaries)) {
		if (!existsSync(binary)) throw new Error(`missing bin/${name}${executableSuffix}`);
		ensureExecutable(binary);
	}
	return binaries;
}

function resolvePackageManifest(
	packageName: string,
	resolvePackage: PackageResolver,
): { readonly manifest?: string; readonly error?: string } {
	try {
		return { manifest: resolvePackage(`${packageName}/package.json`) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function packagedRuntimeCandidate(
	packageName: string,
	resolution: { readonly manifest?: string; readonly error?: string },
): string {
	return resolution.manifest === undefined
		? `${packageName}/postgres-runtime (${resolution.error ?? "package is unavailable"})`
		: join(dirname(resolution.manifest), "postgres-runtime");
}

export async function loadEmbeddedPostgresBinaries(
	options: EmbeddedPostgresLoadOptions = {},
): Promise<EmbeddedPostgresBinaries> {
	const host = options.host ?? {
		platform: process.platform,
		arch: process.arch,
		libc: detectCurrentHostLibc(),
	};
	const target = resolveEmbeddedPostgresTarget(host);
	const searched: string[] = [];
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const resolvePackage = options.resolvePackage ?? createRequire(moduleUrl).resolve;
	const rootPackage = resolvePackageManifest("@bastani/atomic-natives", resolvePackage);
	const leafResolver =
		options.resolvePackage ??
		(rootPackage.manifest === undefined ? resolvePackage : createRequire(rootPackage.manifest).resolve);
	const leafPackage =
		target.nativeLeafPackageName === undefined
			? undefined
			: resolvePackageManifest(target.nativeLeafPackageName, leafResolver);
	const explicitRuntime = options.runtimeDirectory ?? process.env.ATOMIC_POSTGRES_RUNTIME_DIR;
	const candidates: readonly { readonly path?: string; readonly label: string }[] = [
		...(explicitRuntime === undefined ? [] : [{ path: explicitRuntime, label: explicitRuntime }]),
		...(target.nativeLeafPackageName === undefined || leafPackage === undefined
			? []
			: [
					{
						path:
							leafPackage.manifest === undefined
								? undefined
								: join(dirname(leafPackage.manifest), "postgres-runtime"),
						label: packagedRuntimeCandidate(target.nativeLeafPackageName, leafPackage),
					},
				]),
		{
			path: rootPackage.manifest === undefined ? undefined : join(dirname(rootPackage.manifest), "postgres-runtime"),
			label: packagedRuntimeCandidate("@bastani/atomic-natives", rootPackage),
		},
	];
	for (const candidate of candidates) {
		searched.push(candidate.label);
		if (candidate.path === undefined || !existsSync(candidate.path)) continue;
		try {
			return binariesFromDirectory(candidate.path, host.platform);
		} catch (error) {
			searched[searched.length - 1] += ` (${error instanceof Error ? error.message : String(error)})`;
		}
	}

	if (target.npmPackageName !== undefined) {
		searched.push(target.npmPackageName);
		try {
			const importPackage: PackageImporter = options.importPackage ?? (async (specifier) => await import(specifier));
			const binaries = await importPackage(target.npmPackageName);
			if (typeof binaries.pg_ctl !== "string" || typeof binaries.initdb !== "string") {
				throw new Error("package did not export pg_ctl/initdb paths");
			}
			const postgres = join(dirname(binaries.pg_ctl), host.platform === "win32" ? "postgres.exe" : "postgres");
			for (const binary of [binaries.pg_ctl, binaries.initdb, postgres]) ensureExecutable(binary);
			return { pg_ctl: binaries.pg_ctl, initdb: binaries.initdb, postgres };
		} catch (error) {
			searched[searched.length - 1] += ` (${error instanceof Error ? error.message : String(error)})`;
		}
	}

	const libc = host.platform === "linux" ? (host.libc ?? "unknown") : "n/a";
	throw new Error(
		`Embedded Postgres binaries are unavailable for ${host.platform}/${host.arch}/${libc} (target ${target.id}). ` +
			`Searched: ${searched.join(", ")}. Set ATOMIC_POSTGRES_RUNTIME_DIR, configure DBOS_SYSTEM_DATABASE_URL, ` +
			"or make Docker available for fallback.",
	);
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

type SetupLockHeartbeatScheduler = (heartbeat: () => boolean, intervalMs: number) => () => void;

interface HostLeaseTime {
	readonly monotonicMs: number;
	readonly wallTimeMs: number;
}

interface SetupLockOptions {
	/** Compatibility seam for existing focused tests; production uses `clock`. */
	readonly now?: () => number;
	readonly clock?: () => HostLeaseTime;
	readonly wait?: DelayOperation;
	readonly staleMs?: number;
	readonly heartbeatMs?: number;
	readonly attempts?: number;
	readonly scheduleHeartbeat?: SetupLockHeartbeatScheduler;
	readonly isProcessAlive?: (pid: number) => boolean;
	/** Test seam after a complete heartbeat temp record is durable and before replacement. */
	readonly beforeHeartbeatReplace?: (temporaryMarkerPath: string) => void;
}

interface SetupLockLease {
	readonly lockDir: string;
	readonly markerPath: string;
	readonly token: string;
	readonly ownerPid: number;
	readonly abandonedOwnerTokens: ReadonlySet<string>;
}

interface SetupLockWorkContext {
	readonly runtimePublicationLease: RuntimePublicationLease;
	readonly abandonedRuntimeStageOwnerTokens: ReadonlySet<string>;
}

interface LockOwnerRecord {
	readonly token: string;
	readonly pid: number;
	readonly heartbeatMonotonicMs: number;
}

interface LockObservation {
	readonly fingerprint: string;
	readonly latestMtimeMs: number;
	readonly owners: readonly LockOwnerRecord[];
	readonly hasUnexpectedState: boolean;
}

/** Serialize copied-runtime repair, initdb, and start across Atomic processes on this machine. */
async function withSetupLock(
	lockDir: string,
	fn: (setup: SetupLockWorkContext) => Promise<void>,
	options: SetupLockOptions = {},
): Promise<void> {
	const compatibilityNow = options.now;
	const clock =
		options.clock ??
		(compatibilityNow === undefined
			? hostLeaseTime
			: () => {
					const now = compatibilityNow();
					return { monotonicMs: now, wallTimeMs: now };
				});
	const wait = options.wait ?? delay;
	const staleMs = options.staleMs ?? SETUP_LOCK_STALE_MS;
	const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(staleMs / 4));
	const attempts = options.attempts ?? READY_ATTEMPTS;
	const scheduleHeartbeat = options.scheduleHeartbeat ?? scheduleSetupLockHeartbeat;
	const isProcessAlive = options.isProcessAlive ?? processIsAlive;
	let lease: SetupLockLease | undefined;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		lease = acquireSetupLock(lockDir, clock(), staleMs, isProcessAlive);
		if (lease !== undefined) break;
		if (attempt === attempts - 1) {
			throw new Error(`Timed out waiting for another Atomic process to finish Postgres setup (${lockDir}).`);
		}
		await wait(READY_DELAY_MS);
	}
	if (lease === undefined) throw new Error(`Could not acquire the embedded Postgres setup lock (${lockDir}).`);

	const refresh = () => refreshSetupLockLease(lease, clock(), options.beforeHeartbeatReplace);
	const stopHeartbeat = scheduleHeartbeat(refresh, heartbeatMs);
	try {
		await fn({
			runtimePublicationLease: { ownerToken: lease.token, refresh },
			abandonedRuntimeStageOwnerTokens: lease.abandonedOwnerTokens,
		});
	} finally {
		stopHeartbeat();
		releaseSetupLock(lease);
	}
}

function acquireSetupLock(
	lockDir: string,
	now: HostLeaseTime,
	staleMs: number,
	isProcessAlive: (pid: number) => boolean,
): SetupLockLease | undefined {
	const abandonedOwnerTokens = new Set<string>();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = `${process.pid}-${crypto.randomUUID()}`;
		const markerPath = join(lockDir, `.owner-${token}`);
		try {
			mkdirSync(lockDir);
			try {
				writeFileSync(
					markerPath,
					serializeLockOwner({ token, pid: process.pid, heartbeatMonotonicMs: now.monotonicMs }),
					{
						flag: "wx",
						mode: 0o600,
					},
				);
				return { lockDir, markerPath, token, ownerPid: process.pid, abandonedOwnerTokens };
			} catch (error) {
				try {
					rmdirSync(lockDir);
				} catch {
					// Unexpected content means ownership was never established.
				}
				throw error;
			}
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
		}

		const observation = observeSetupLock(lockDir);
		if (observation === undefined || !setupLockIsStale(observation, now, staleMs, isProcessAlive)) return undefined;
		const abandoned = breakStaleSetupLock(lockDir, observation, now, staleMs, token, isProcessAlive);
		if (abandoned === undefined) return undefined;
		for (const abandonedToken of abandoned) abandonedOwnerTokens.add(abandonedToken);
	}
	return undefined;
}
function refreshSetupLockLease(
	lease: SetupLockLease,
	now: HostLeaseTime,
	beforeReplace?: (temporaryMarkerPath: string) => void,
): boolean {
	if (!ownsSetupLock(lease)) return false;
	const record = { token: lease.token, pid: lease.ownerPid, heartbeatMonotonicMs: now.monotonicMs };
	const temporaryMarkerPath = join(lease.lockDir, `.owner-${lease.token}.tmp-${crypto.randomUUID()}`);
	try {
		writeFileSync(temporaryMarkerPath, serializeLockOwner(record), {
			flag: "wx",
			mode: 0o600,
			flush: true,
		});
		beforeReplace?.(temporaryMarkerPath);
		if (!ownsSetupLock(lease)) {
			removeMarkerIfOwned(temporaryMarkerPath, record);
			return false;
		}
		// Same-directory rename is the record's atomic commit on every supported
		// platform. Node's Windows implementation requests replace-existing; if a
		// platform or scanner still rejects it, retain the intact old marker and
		// fail ownership rather than falling back to an in-place write.
		renameSync(temporaryMarkerPath, lease.markerPath);
		return ownsSetupLock(lease);
	} catch {
		removeMarkerIfOwned(temporaryMarkerPath, record);
		return false;
	}
}

function removeMarkerIfOwned(path: string, expected: LockOwnerRecord): void {
	try {
		if (!lstatSync(path).isFile()) return;
		const record = parseLockOwner(readFileSync(path, "utf8"));
		if (
			record?.token === expected.token &&
			record.pid === expected.pid &&
			record.heartbeatMonotonicMs === expected.heartbeatMonotonicMs
		) {
			rmSync(path, { force: true });
		}
	} catch {
		// A displaced/replaced temp record is not ours to remove.
	}
}

function ownsSetupLock(lease: SetupLockLease): boolean {
	try {
		const record = parseLockOwner(readFileSync(lease.markerPath, "utf8"));
		return record?.token === lease.token && record.pid === lease.ownerPid && lstatSync(lease.markerPath).isFile();
	} catch {
		return false;
	}
}

function releaseSetupLock(lease: SetupLockLease): void {
	if (!ownsSetupLock(lease)) return;
	// The marker name is unique to this owner. If a stale takeover moved the old
	// directory and installed a new one, this path cannot name the new marker;
	// rmdir is also non-recursive and therefore cannot erase another owner.
	rmSync(lease.markerPath, { force: true });
	try {
		rmdirSync(lease.lockDir);
	} catch {
		// Unexpected content is left for bounded stale recovery, never swept here.
	}
}

function breakStaleSetupLock(
	lockDir: string,
	observed: LockObservation,
	now: HostLeaseTime,
	staleMs: number,
	token: string,
	isProcessAlive: (pid: number) => boolean,
): readonly string[] | undefined {
	const breakPath = `${lockDir}.stale-${token}`;
	try {
		renameSync(lockDir, breakPath);
	} catch {
		return undefined;
	}
	const displaced = observeSetupLock(breakPath);
	if (
		displaced === undefined ||
		displaced.fingerprint !== observed.fingerprint ||
		!setupLockIsStale(displaced, now, staleMs, isProcessAlive)
	) {
		try {
			renameSync(breakPath, lockDir);
		} catch {
			// A concurrent contender now owns the fixed path. The displaced owner
			// will observe loss of its unique marker and cannot remove that lock.
		}
		return undefined;
	}
	const abandoned = displaced.owners.filter((owner) => !isProcessAlive(owner.pid)).map((owner) => owner.token);
	rmSync(breakPath, { recursive: true, force: true });
	return abandoned;
}

function observeSetupLock(path: string): LockObservation | undefined {
	try {
		const parts: string[] = [];
		const owners: LockOwnerRecord[] = [];
		let latestMtimeMs = Number.NEGATIVE_INFINITY;
		let hasUnexpectedState = false;
		const visit = (entryPath: string, name: string): void => {
			const stat = lstatSync(entryPath);
			latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
			let type = "other";
			if (stat.isDirectory()) type = "directory";
			else if (stat.isFile()) type = "file";
			else if (stat.isSymbolicLink()) type = "link";
			parts.push(`${name}:${type}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
			if (stat.isDirectory()) {
				for (const child of readdirSync(entryPath).sort()) visit(join(entryPath, child), `${name}/${child}`);
			} else if (stat.isFile()) {
				const contents = readFileSync(entryPath, "utf8");
				parts.push(contents);
				const owner = parseLockOwner(contents);
				if (owner !== undefined && markerNameMatchesOwner(name, owner)) owners.push(owner);
				else hasUnexpectedState = true;
			} else if (stat.isSymbolicLink()) {
				parts.push(readlinkSync(entryPath));
				hasUnexpectedState = true;
			} else {
				hasUnexpectedState = true;
			}
		};
		visit(path, ".");
		return { fingerprint: parts.join("\0"), latestMtimeMs, owners, hasUnexpectedState };
	} catch {
		return undefined;
	}
}

function markerNameMatchesOwner(name: string, owner: LockOwnerRecord): boolean {
	const stableName = `./.owner-${owner.token}`;
	return name === stableName || name.startsWith(`${stableName}.tmp-`);
}

function setupLockIsStale(
	observation: LockObservation,
	now: HostLeaseTime,
	staleMs: number,
	isProcessAlive: (pid: number) => boolean,
): boolean {
	for (const owner of observation.owners) {
		// A dead recorded process is abandoned even when a reboot's new uptime has
		// already crossed its old low uptime. PID reuse fails closed as live and
		// falls back to the bounded monotonic age check.
		if (!isProcessAlive(owner.pid)) continue;
		// Uptime cannot move backward within one boot. A lower current value is
		// therefore reboot/monotonic-reset evidence and the old lease is stale.
		if (now.monotonicMs >= owner.heartbeatMonotonicMs && now.monotonicMs - owner.heartbeatMonotonicMs <= staleMs) {
			return false;
		}
	}
	if (!observation.hasUnexpectedState) return observation.owners.length > 0;
	// Finite migration handling for malformed/legacy locks. A future mtime is
	// rollback evidence rather than a lease that can stay fresh indefinitely.
	return now.wallTimeMs < observation.latestMtimeMs || now.wallTimeMs - observation.latestMtimeMs > staleMs;
}
function serializeLockOwner(owner: LockOwnerRecord): string {
	const serialized = JSON.stringify(owner);
	if (serialized.length > 255) throw new Error("Embedded Postgres setup-lock owner record is unexpectedly large.");
	return serialized.padEnd(256, "\n");
}

function parseLockOwner(value: string): LockOwnerRecord | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<LockOwnerRecord>;
		if (
			typeof parsed.token !== "string" ||
			parsed.token === "" ||
			!Number.isInteger(parsed.pid) ||
			(parsed.pid ?? 0) <= 0 ||
			!Number.isFinite(parsed.heartbeatMonotonicMs) ||
			(parsed.heartbeatMonotonicMs ?? -1) < 0
		) {
			return undefined;
		}
		return {
			token: parsed.token,
			pid: parsed.pid,
			heartbeatMonotonicMs: parsed.heartbeatMonotonicMs,
		} as LockOwnerRecord;
	} catch {
		return undefined;
	}
}

function hostLeaseTime(): HostLeaseTime {
	return { monotonicMs: uptime() * 1000, wallTimeMs: Date.now() };
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		return code !== "ESRCH";
	}
}

function scheduleSetupLockHeartbeat(heartbeat: () => boolean, intervalMs: number): () => void {
	const timer = setInterval(() => {
		if (!heartbeat()) clearInterval(timer);
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}

function logTail(logFile: string): string {
	try {
		const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
		return `\nPostgres log tail:\n${lines.slice(-5).join("\n")}`;
	} catch {
		return "";
	}
}
function setActiveClusterForTests(lease: RetainedPostgres | undefined): ActiveEmbeddedPostgres | undefined {
	activeCluster = lease === undefined ? undefined : { lease };
	return activeCluster;
}

function setRetainedPostgresSpawnerForTests(spawner: RetainedPostgresSpawner | undefined): void {
	retainedPostgresSpawnerOverride = spawner;
}

function setEnsureOperationForTests(operation: EnsureOperation | undefined): void {
	ensured = undefined;
	ensureOperation = operation ?? ensure;
}

/** Narrow seams for retained-process lifecycle tests. */
export const embeddedPostgresTestHooks = {
	ensure: ensureEmbeddedDbosPostgres,
	setActiveCluster: setActiveClusterForTests,
	setEnsureOperation: setEnsureOperationForTests,
	setRetainedPostgresSpawner: setRetainedPostgresSpawnerForTests,
	startCluster,
	waitForClusterReadiness,
	withSetupLock,
};

export function resetEmbeddedDbosPostgresForTests(): void {
	ensured = undefined;
	activeCluster?.lease.release();
	activeCluster = undefined;
	ensureOperation = ensure;
	retainedPostgresSpawnerOverride = undefined;
}
