/**
 * Embedded Postgres for DBOS workflow durability.
 *
 * When no `DBOS_SYSTEM_DATABASE_URL` is configured, Atomic runs DBOS against
 * its own Postgres instance. An explicit runtime directory takes precedence,
 * followed by a target-specific `@bastani/atomic-natives` payload (including
 * archive-local payloads), then the existing `@embedded-postgres/*` packages.
 * No Docker daemon or system Postgres is required on supported targets.
 *
 * The cluster lives under `~/.atomic/postgres/v<major>` on a dedicated port.
 * Atomic starts Postgres directly and retains an opaque native process lease;
 * releasing that lease does not kill the server, so it survives abrupt exits
 * and can be shared by concurrent sessions. Only an unpublished startup or a
 * verified managed server whose runtime has disappeared may be stopped; a
 * shared runtime restart is elected under the cluster setup lock.
 *
 * On Windows, Administrative accounts run PostgreSQL through a restricted
 * access token (mirroring pg_ctl), because the server refuses to start for a
 * member of the Administrators or Power Users groups.
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
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, uptime } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { RetainedPostgres, RetainedPostgresSpawnOptions } from "@bastani/atomic-natives";
import { DbosDependencyError } from "./dbos-admission.js";
import {
	cleanupAbandonedRuntimeStages,
	type EmbeddedPostgresRunContext,
	fingerprintPreparedRuntime,
	prepareBinariesForOwner,
	type RuntimePublicationLease,
	resolveEmbeddedRunContext,
} from "./dbos-embedded-postgres-root.js";
import {
	detectCurrentHostLibc,
	type EmbeddedPostgresHost,
	resolveEmbeddedPostgresTarget,
} from "./dbos-embedded-postgres-targets.js";
import { PostgresHealth } from "./dbos-postgres-health.js";
import {
	availablePostgresPort,
	managedPostgresRuntimeHealthy,
	managedPostmaster,
	POSTGRES_IDENTITY_SQL,
	POSTGRES_TIMEZONE_SQL,
	type PostgresIdentityProbe,
	type PostgresIdentityRow,
	postgresRuntimeFilesExist,
	preferredPostgresPort,
	probePostgresTimezoneData,
	verifyPostgresIdentity,
} from "./dbos-postgres-identity.js";
import {
	acquirePostgresConsumer,
	inspectPostgresConsumers,
	type ManagedPostgresMetadata,
	type ManagedPostgresServer,
	managedPostgresMetadata,
	type PostgresConsumerLease,
	postgresOwnershipDirectory,
	publishPostgresServer,
} from "./dbos-postgres-ownership.js";
import { commandFailureDetail, delay, runLocalCommand, tcpReachable } from "./local-command.js";

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

let actualPort = EMBEDDED_PORT;
export function embeddedDbosSystemDatabaseUrl(): string {
	return EMBEDDED_DBOS_SYSTEM_DATABASE_URL.replace(`:${EMBEDDED_PORT}/`, `:${actualPort}/`);
}

interface EmbeddedPostgresBinaries {
	readonly pg_ctl: string;
	readonly initdb: string;
	readonly postgres: string;
	readonly sealedIdentity?: string;
}

type RetainedPostgresSpawner = (options: RetainedPostgresSpawnOptions) => RetainedPostgres;

interface ActiveEmbeddedPostgres {
	readonly lease: RetainedPostgres;
	shared?: boolean;
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
let consumer: PostgresConsumerLease | undefined;
let initializing = false;
let health: PostgresHealth | undefined;
export function embeddedPostgresHealth(): PostgresHealth | undefined {
	return health;
}

/** Start once, then verify the live shared identity on subsequent requests. */
export function ensureEmbeddedDbosPostgres(): Promise<void> {
	if (ensured !== undefined && !initializing && health !== undefined) return health.check().then(() => {});
	if (ensured === undefined && activeCluster !== undefined) {
		return Promise.reject(
			new EmbeddedPostgresCleanupPendingError(
				[],
				"Embedded Postgres startup is blocked while retained Postgres cleanup is pending; retry shutdown first.",
			),
		);
	}
	if (ensured === undefined) initializing = true;
	ensured ??= ensureOperation()
		.catch((error: unknown) => {
			ensured = undefined;
			throw error;
		})
		.finally(() => {
			initializing = false;
		});
	return ensured;
}

async function ensure(): Promise<void> {
	const loaded = await loadEmbeddedPostgresBinaries();
	hydrateBinaryLibraryLinks(loaded.pg_ctl);
	// An older server listening on the shared port must not hide a broken installation.
	for (const binary of [loaded.postgres, loaded.pg_ctl, loaded.initdb]) {
		const result = await runLocalCommand(binary, ["--version"]);
		if (result.exitCode !== 0)
			throw new Error(`incomplete PostgreSQL runtime: ${binary} --version failed: ${commandFailureDetail(result)}`);
	}
	await ensureCluster({ binaries: loaded });
}

async function ensureCluster(
	options: {
		context?: EmbeddedPostgresRunContext;
		binaries?: EmbeddedPostgresBinaries;
		isReachable?: ReachabilityProbe;
		probeIdentity?: PostgresIdentityProbe;
		recovery?: ManagedPostgresMetadata;
		prepared?: boolean;
		runtimeIdentity?: string;
	} = {},
): Promise<void> {
	const isReachable = options.isReachable ?? tcpReachable;
	const context = options.context ?? (await resolveEmbeddedRunContext());
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
	await withSetupLock(join(root, `v${EMBEDDED_PG_MAJOR}.setup-lock`), async (setup) => {
		let adoptedRegistry: string | undefined;
		try {
			await cleanupAbandonedRuntimeStages(root, setup.abandonedRuntimeStageOwnerTokens);
			const preferredPort = preferredPostgresPort();
			const registered = existsSync(postgresOwnershipDirectory(root, EMBEDDED_PG_MAJOR));
			if (existsSync(dataDir)) {
				const data = lstatSync(dataDir);
				if (
					!data.isDirectory() ||
					(process.getuid !== undefined && data.uid !== (context.owner?.uid ?? process.getuid())) ||
					(process.platform !== "win32" && (data.mode & 0o022) !== 0)
				) {
					throw new Error(`Untrusted managed Postgres data directory: ${dataDir}`);
				}
			}
			if (!existsSync(join(dataDir, "PG_VERSION")) && registered) {
				throw new Error(`Managed Postgres data is missing PG_VERSION; preserve its ownership records: ${dataDir}`);
			}
			const unregisteredData = !registered && existsSync(dataDir) && readdirSync(dataDir).length > 0;
			if (unregisteredData && (options.recovery || !launchedByPreOwnershipAtomic(dataDir))) {
				throw new Error(
					`Refusing to adopt unregistered Postgres data: ${dataDir}. Preserve it and configure DBOS_SYSTEM_DATABASE_URL explicitly.`,
				);
			}
			let metadata =
				registered || unregisteredData
					? managedPostgresMetadata(root, EMBEDDED_PG_MAJOR, unregisteredData)
					: undefined;
			if (unregisteredData) adoptedRegistry = postgresOwnershipDirectory(root, EMBEDDED_PG_MAJOR);
			if (options.recovery && !metadata)
				throw new Error("Managed Postgres recovery requires existing ownership records.");
			if (
				options.recovery &&
				(metadata?.clusterId !== options.recovery.clusterId ||
					metadata.directoryIdentity !== options.recovery.directoryIdentity ||
					metadata.server?.systemIdentifier !== options.recovery.server?.systemIdentifier)
			) {
				throw new Error("Managed Postgres recovery identity changed while waiting for ownership.");
			}
			const existing = metadata && managedPostmaster(metadata);
			let port = existing?.port ?? metadata?.server?.port ?? preferredPort;
			if (
				existing &&
				metadata?.server &&
				(existing.pid !== metadata.server.pid ||
					existing.started !== metadata.server.started ||
					existing.port !== metadata.server.port)
			) {
				throw new Error(
					"Managed Postgres published process identity mismatch. Preserve the cluster and ownership records.",
				);
			}
			let verified: ManagedPostgresServer | undefined;
			let prepared = options.prepared ? options.binaries : undefined;
			const assertCachedRuntimeIntegrity = async (binaries: EmbeddedPostgresBinaries) => {
				if (
					options.runtimeIdentity !== undefined &&
					(await fingerprintPreparedRuntime(binaries, { publicationLease: setup.runtimePublicationLease })) !==
						options.runtimeIdentity
				) {
					throw new Error("Replacement managed Postgres runtime changed; preserving the running server.");
				}
			};
			if (existing) {
				await waitForClusterReadiness(
					logFile,
					undefined,
					async () => {
						verified = await verifyPostgresIdentity(metadata!, port, existing.pid, options.probeIdentity);
						// A shutdown can overlap the SQL probe. Once that postmaster is gone,
						// leave the attach wait and start under this same setup lease instead
						// of polling the captured PID until the readiness deadline expires.
						return verified !== undefined || managedPostmaster(metadata!) === undefined;
					},
					READY_ATTEMPTS,
					delay,
					port,
				);
			}
			if (verified && !managedPostgresRuntimeHealthy(metadata!, port)) {
				const loaded = options.binaries ?? (await loadEmbeddedPostgresBinaries());
				prepared ??= await prepareBinariesForOwner(loaded, context, undefined, {
					publicationLease: setup.runtimePublicationLease,
				});
				if (
					!postgresRuntimeFilesExist(prepared.postgres) ||
					![prepared.pg_ctl, prepared.initdb].every((binary) =>
						lstatSync(binary, { throwIfNoEntry: false })?.isFile(),
					)
				) {
					throw new Error("Replacement managed Postgres runtime is incomplete; preserving the running server.");
				}
				await assertCachedRuntimeIntegrity(prepared);
				if (adoptedRegistry !== undefined) {
					if (!setup.runtimePublicationLease.refresh())
						throw new Error("Postgres setup lease lost before legacy adoption.");
					publishPostgresServer(root, metadata!, verified);
					adoptedRegistry = undefined;
				}
				if (
					await stopBrokenManagedPostmaster(
						metadata!,
						verified,
						prepared.pg_ctl,
						context,
						setup.runtimePublicationLease,
						options.probeIdentity,
					)
				) {
					activeCluster?.lease.release();
					activeCluster = undefined;
					verified = undefined;
				}
			}
			if (!verified) {
				const loaded = options.binaries ?? (await loadEmbeddedPostgresBinaries());
				const binaries =
					prepared ??
					(await prepareBinariesForOwner(loaded, context, undefined, {
						publicationLease: setup.runtimePublicationLease,
					}));
				prepared = binaries;
				await assertCachedRuntimeIntegrity(binaries);
				if (!existsSync(join(dataDir, "PG_VERSION"))) {
					if (options.recovery) throw new Error("Managed Postgres recovery must not initialize data.");
					if (existsSync(postgresOwnershipDirectory(root, EMBEDDED_PG_MAJOR))) {
						throw new Error(
							`Managed Postgres data is missing PG_VERSION; preserve its ownership records: ${dataDir}`,
						);
					}
					if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
						throw new Error(`Refusing to initialize nonempty Postgres data directory: ${dataDir}`);
					}
					await initializeCluster(binaries.initdb, dataDir, context);
				}
				metadata ??= managedPostgresMetadata(root, EMBEDDED_PG_MAJOR, true);
				for (let attempt = 0; attempt < 3; attempt++) {
					port = await availablePostgresPort(attempt === 0 ? port : 0);
					if (!setup.runtimePublicationLease.refresh()) throw new Error("Postgres setup lease lost before start.");
					try {
						const lease = await startCluster(binaries.postgres, dataDir, logFile, context, port);
						startedCluster = { lease };
						activeCluster = startedCluster;
						await waitForClusterReadiness(
							logFile,
							startedCluster,
							async () => {
								verified = await verifyPostgresIdentity(metadata!, port, lease.pid, options.probeIdentity);
								return verified !== undefined;
							},
							READY_ATTEMPTS,
							delay,
							port,
						);
						break;
					} catch (error) {
						// Only an observed early exit/bind failure plus a competitor permits retry.
						// Cleanup has already settled the exact child; no listener is signaled.
						if (
							activeCluster !== undefined ||
							attempt === 2 ||
							!(error instanceof Error) ||
							!/exited early|address already in use|EADDRINUSE/i.test(error.message) ||
							!(await isReachable(EMBEDDED_HOST, port, 1000))
						)
							throw error;
						startedCluster = undefined;
					}
				}
			}
			if (!metadata || !verified) throw new Error("Managed Postgres identity was not verified.");
			if (options.probeIdentity === undefined) await probePostgresTimezoneData(verified.port);
			let runtimeIdentity: string | undefined;
			if (health === undefined) {
				prepared ??= await prepareBinariesForOwner(
					options.binaries ?? (await loadEmbeddedPostgresBinaries()),
					context,
					undefined,
					{ publicationLease: setup.runtimePublicationLease },
				);
				runtimeIdentity =
					prepared.sealedIdentity ??
					(await fingerprintPreparedRuntime(prepared, { publicationLease: setup.runtimePublicationLease }));
			}
			if (!setup.runtimePublicationLease.refresh()) throw new Error("Postgres setup lease lost before attach.");
			publishPostgresServer(root, metadata, verified);
			adoptedRegistry = undefined;
			actualPort = port;
			inspectPostgresConsumers(root, metadata);
			const nextConsumer = acquirePostgresConsumer(root, metadata, `${process.execPath} | ${import.meta.url}`);
			consumer?.release();
			consumer = nextConsumer;
			if (health === undefined) {
				const pinned = { ...metadata, server: verified };
				const recoveryOptions = {
					...options,
					context,
					binaries: prepared,
					prepared: true,
					recovery: pinned,
					runtimeIdentity,
				};
				const inspect = async (probe = options.probeIdentity) => {
					const current = managedPostgresMetadata(root, EMBEDDED_PG_MAJOR, false);
					if (
						current.clusterId !== pinned.clusterId ||
						current.directoryIdentity !== pinned.directoryIdentity ||
						current.server?.systemIdentifier !== pinned.server.systemIdentifier
					) {
						throw new Error(
							"Managed Postgres health identity mismatch. Preserve the data and ownership records.",
						);
					}
					const server = current.server;
					if (!server) throw new Error("Managed Postgres published identity is missing.");
					const live = await verifyPostgresIdentity(current, server.port, server.pid, probe);
					if (!live) return undefined;
					if (live.started !== server.started)
						throw new Error("Managed Postgres published start identity mismatch.");
					if (!managedPostgresRuntimeHealthy(current, live.port)) return undefined;
					if (probe === undefined) await probePostgresTimezoneData(live.port);
					actualPort = live.port;
					return { url: embeddedDbosSystemDatabaseUrl(), identity: JSON.stringify(live) };
				};
				health = new PostgresHealth({
					probe: () => inspect(),
					validate: async (client) => {
						// Bind SQL identity to this borrowed socket, not just a prior probe on the same port.
						const identity = await inspect(async () => {
							// pg supports per-query read timeouts; @types/pg omits this option from QueryConfig.
							const query = { text: POSTGRES_IDENTITY_SQL, query_timeout: 1000 };
							const result = await client.query<PostgresIdentityRow>(query);
							return result.rows[0];
						});
						if (!identity) throw new DbosDependencyError();
						if (options.probeIdentity === undefined) {
							const query = { text: POSTGRES_TIMEZONE_SQL, query_timeout: 1000 };
							await client.query(query);
						}
					},
					recover: async () => {
						if (activeCluster && !activeCluster.shared)
							throw new Error("Managed Postgres cleanup is still pending.");
						// The elected setup operation may gracefully stop only an exact verified
						// server whose runtime is missing. Other published servers are never signaled.
						activeCluster?.lease.release();
						activeCluster = undefined;
						await ensureCluster(recoveryOptions);
					},
				});
			}
		} catch (startupError) {
			// Readiness already attempted rollback; retain its lease for a later shutdown retry.
			if (startupError instanceof EmbeddedPostgresCleanupPendingError) throw startupError;
			await rollbackStartedCluster(startedCluster, startupError).catch((error: unknown) => {
				// Unpublished adoption must leave the data unregistered so the next startup re-runs the legacy check.
				if (adoptedRegistry !== undefined && !(error instanceof EmbeddedPostgresCleanupPendingError))
					rmSync(adoptedRegistry, { recursive: true, force: true });
				throw error;
			});
		}
	});
}

async function stopBrokenManagedPostmaster(
	metadata: ManagedPostgresMetadata,
	verified: ManagedPostgresServer,
	pgCtl: string,
	context: EmbeddedPostgresRunContext,
	lease: RuntimePublicationLease,
	probe?: PostgresIdentityProbe,
): Promise<boolean> {
	// The setup lock excludes another Atomic starter. Reverify SQL, pidfile and
	// publication immediately before pg_ctl stops this exact managed data directory.
	const current = managedPostgresMetadata(context.baseDir, metadata.major, false);
	if (
		current.clusterId !== metadata.clusterId ||
		current.directoryIdentity !== metadata.directoryIdentity ||
		current.server?.pid !== verified.pid ||
		current.server.started !== verified.started ||
		current.server.systemIdentifier !== verified.systemIdentifier
	) {
		throw new Error("Managed Postgres restart identity changed. Preserve the server and data directory.");
	}
	const live = await verifyPostgresIdentity(current, verified.port, verified.pid, probe);
	if (!live || live.started !== verified.started || live.systemIdentifier !== verified.systemIdentifier) {
		throw new Error("Managed Postgres restart cannot verify the published server identity.");
	}
	if (managedPostgresRuntimeHealthy(current, verified.port)) return false;
	if (!lease.refresh()) throw new Error("Postgres setup lease lost before stopping the verified managed server.");
	const stopped = await context.runAsOwner(pgCtl, ["-D", metadata.dataDir, "-m", "fast", "-w", "-t", "30", "stop"]);
	if (stopped.exitCode !== 0) {
		throw new Error(
			`Could not gracefully stop the verified managed Postgres server: ${commandFailureDetail(stopped)}`,
		);
	}
	if (managedPostmaster(current) !== undefined) {
		throw new Error("Managed Postgres shutdown completed without releasing its verified postmaster.");
	}
	return true;
}

async function rollbackStartedCluster(
	cluster: ActiveEmbeddedPostgres | undefined,
	startupError: unknown,
): Promise<never> {
	if (cluster !== undefined && activeCluster === cluster) {
		try {
			await stopActiveCluster(cluster);
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
	port = EMBEDDED_PORT,
): Promise<void> {
	const deadline = performance.now() + READY_ATTEMPTS * READY_DELAY_MS;
	try {
		for (let attempt = 0; attempt < attempts && performance.now() < deadline; attempt += 1) {
			await assertRetainedPostgresRunning(rollbackCluster, logFile, port);
			if (await isReachable(EMBEDDED_HOST, port)) {
				// The owned process can exit while the asynchronous TCP probe connects
				// to another listener. Observe it again before accepting readiness.
				await assertRetainedPostgresRunning(rollbackCluster, logFile, port);
				if (rollbackCluster !== undefined) rollbackCluster.shared = true;
				return;
			}
			await wait(READY_DELAY_MS);
		}
		throw new Error(
			`Embedded Postgres started but never accepted connections on ${EMBEDDED_HOST}:${port}; see ${logFile}.`,
		);
	} catch (startupError) {
		await rollbackStartedCluster(rollbackCluster, startupError);
	}
}

async function assertRetainedPostgresRunning(
	cluster: ActiveEmbeddedPostgres | undefined,
	logFile: string,
	port = EMBEDDED_PORT,
): Promise<void> {
	if (cluster === undefined) return;
	// Native wait(0) has no typed timeout code: match only its exact live-child
	// timeout. Query/lock failures must reach the owned startup rollback.
	const observed = await cluster.lease.wait(0).catch((error: Error) => {
		if (error instanceof Error && error.message === "Timed out waiting for the retained Postgres process to exit") {
			return undefined;
		}
		throw error;
	});
	if (observed?.exited) {
		throw new Error(
			`The embedded Postgres process exited early before accepting connections on ${EMBEDDED_HOST}:${port}; see ${logFile}.${logTail(logFile)}`,
		);
	}
}

/** Detach from a published server; stop only an unpublished startup lease. */
export function shutdownEmbeddedDbosPostgres(): Promise<void> {
	if (initializing && ensured !== undefined) return ensured.catch(() => {}).then(() => shutdownEmbeddedDbosPostgres());
	if (health !== undefined) {
		const previous = health;
		return previous.stop().then(() => {
			if (health === previous) health = undefined;
			return shutdownEmbeddedDbosPostgres();
		});
	}
	consumer?.release();
	consumer = undefined;
	ensured = undefined;
	const cluster = activeCluster;
	if (cluster === undefined) return Promise.resolve();
	cluster.stopPromise ??= stopActiveCluster(cluster);
	return cluster.stopPromise;
}

async function stopActiveCluster(cluster: ActiveEmbeddedPostgres): Promise<void> {
	try {
		if (!cluster.shared) await cluster.lease.interruptAndWait(SHUTDOWN_TIMEOUT_MS);
		cluster.lease.release();
		if (activeCluster === cluster) activeCluster = undefined;
		ensured = undefined;
	} catch (error) {
		// Timeout or signaling failure retains this exact native lease so a later
		// orderly-shutdown attempt can retry without reconstructing ownership.
		cluster.stopPromise = undefined;
		throw error;
	}
}

function launchedByPreOwnershipAtomic(dataDir: string): boolean {
	const versionFile = join(dataDir, "PG_VERSION");
	const optsFile = join(dataDir, "postmaster.opts");
	try {
		if (!lstatSync(versionFile).isFile() || !lstatSync(optsFile).isFile()) return false;
		if (readFileSync(versionFile, "utf8").trim() !== String(EMBEDDED_PG_MAJOR)) return false;
		const launch =
			/^.+[\\/]postgres(?:\.exe)? "-D" "([^"]+)" "-p" "\d+" "-c" "listen_addresses=127\.0\.0\.1"\s*$/.exec(
				readFileSync(optsFile, "utf8"),
			);
		if (!launch || !isAbsolute(launch[1])) return false;
		if (launch[1] === dataDir) return true;
		return realpathSync(launch[1]) === realpathSync(dataDir);
	} catch {
		return false;
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
	port = EMBEDDED_PORT,
): Promise<RetainedPostgres> {
	try {
		return retainedPostgresSpawner()({
			executable: postgres,
			args: ["-D", dataDir, "-p", String(port), "-c", `listen_addresses=${EMBEDDED_HOST}`],
			cwd: dataDir,
			logFile,
			...(context.owner === undefined ? {} : { uid: context.owner.uid, gid: context.owner.gid }),
		});
	} catch (error) {
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
	} catch (cause) {
		throw new Error(`incomplete PostgreSQL runtime: invalid ${manifestPath}`, { cause });
	}
	if (
		!Array.isArray(manifest) ||
		manifest.some(
			(link) =>
				link === null || typeof link !== "object" || !safeLibraryPath(link.source) || !safeLibraryPath(link.target),
		)
	) {
		throw new Error(`incomplete PostgreSQL runtime: invalid aliases in ${manifestPath}`);
	}
	const firstSource = manifest[0]?.source;
	if (
		firstSource?.startsWith("native/") &&
		!existsSync(join(manifestRoot, firstSource)) &&
		existsSync(join(dirname(manifestRoot), firstSource))
	) {
		manifestRoot = dirname(manifestRoot);
	}
	const canonicalRoot = realpathSync(manifestRoot);
	const targets = new Map<string, string>();
	const plannedSources = new Map<string, string>();
	const plans = manifest.map(({ source, target }) => {
		const sourcePath = join(manifestRoot, source);
		// An earlier manifest entry can supply this source without writing it yet.
		const absoluteSource = lstatSync(sourcePath, { throwIfNoEntry: false })
			? sourcePath
			: (plannedSources.get(source) ?? sourcePath);
		const absoluteTarget = join(manifestRoot, target);
		try {
			for (const path of [absoluteSource, dirname(absoluteTarget)]) {
				const contained = relative(canonicalRoot, realpathSync(path));
				if (
					isAbsolute(contained) ||
					contained === ".." ||
					contained.startsWith("../") ||
					contained.startsWith("..\\")
				)
					throw new Error(`alias escapes runtime: ${target}`);
			}
			if (!statSync(absoluteSource).isFile()) throw new Error(`invalid source: ${source}`);
			if (targets.has(target) && targets.get(target) !== source) throw new Error(`conflicting alias: ${target}`);
			targets.set(target, source);
			if (lstatSync(absoluteTarget, { throwIfNoEntry: false }) && !existsSync(absoluteTarget))
				throw new Error(`dangling alias target: ${target}`);
			if (existsSync(absoluteTarget)) {
				const contained = relative(canonicalRoot, realpathSync(absoluteTarget));
				if (
					isAbsolute(contained) ||
					contained === ".." ||
					contained.startsWith("../") ||
					contained.startsWith("..\\") ||
					!statSync(absoluteTarget).isFile() ||
					!readFileSync(absoluteTarget).equals(readFileSync(absoluteSource))
				)
					throw new Error(`invalid alias target: ${target}`);
			}
		} catch (cause) {
			throw new Error(`incomplete PostgreSQL runtime: ${source} -> ${target}`, { cause });
		}
		plannedSources.set(target, absoluteSource);
		return { absoluteSource, absoluteTarget };
	});
	for (const { absoluteSource, absoluteTarget } of plans) {
		// A previous entry may have created this filesystem-equivalent target
		// since planning (case folding, Unicode normalization, or a link callback).
		if (lstatSync(absoluteTarget, { throwIfNoEntry: false })) {
			const contained = relative(canonicalRoot, realpathSync(absoluteTarget));
			if (
				isAbsolute(contained) ||
				contained === ".." ||
				contained.startsWith("../") ||
				contained.startsWith("..\\") ||
				!statSync(absoluteTarget).isFile() ||
				!readFileSync(absoluteTarget).equals(readFileSync(absoluteSource))
			)
				throw new Error(`incomplete PostgreSQL runtime: invalid alias target: ${absoluteTarget}`);
			continue;
		}
		try {
			createLink(relative(dirname(absoluteTarget), absoluteSource), absoluteTarget);
		} catch {
			try {
				copyFile(absoluteSource, absoluteTarget);
			} catch (cause) {
				throw new Error(`incomplete PostgreSQL runtime: cannot materialize ${absoluteTarget}`, { cause });
			}
		}
	}
}

function safeLibraryPath(path: string): boolean {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!path.startsWith("/") &&
		!/[\\:\u0000]/u.test(path) &&
		!path.split("/").some((part) => part === ".." || part === "." || part === "")
	);
}

type PackageResolver = (specifier: string) => string;
type PackageImporter = (specifier: string) => Promise<Partial<EmbeddedPostgresBinaries>>;

interface EmbeddedPostgresLoadOptions {
	/** Inspection must not repair executable permissions. */
	readonly readOnly?: boolean;
	readonly host?: EmbeddedPostgresHost;
	readonly runtimeDirectory?: string;
	readonly moduleUrl?: string;
	readonly resolvePackage?: PackageResolver;
	readonly importPackage?: PackageImporter;
}

function binariesFromDirectory(
	runtimeDirectory: string,
	platform: NodeJS.Platform,
	readOnly = false,
): EmbeddedPostgresBinaries {
	const executableSuffix = platform === "win32" ? ".exe" : "";
	const binaries = {
		pg_ctl: join(runtimeDirectory, "bin", `pg_ctl${executableSuffix}`),
		initdb: join(runtimeDirectory, "bin", `initdb${executableSuffix}`),
		postgres: join(runtimeDirectory, "bin", `postgres${executableSuffix}`),
	};
	for (const [name, binary] of Object.entries(binaries)) {
		if (!existsSync(binary)) throw new Error(`missing bin/${name}${executableSuffix}`);
		if (!readOnly) ensureExecutable(binary);
	}
	return binaries;
}

/**
 * Reject only a readable provenance record that identifies another target.
 * Missing or unreadable provenance remains compatible with existing archives.
 */
function packagedRuntimeTargetMismatch(runtimeDirectory: string, expectedTarget: string): string | undefined {
	const provenancePath = join(runtimeDirectory, "runtime-provenance.json");
	if (!existsSync(provenancePath)) return undefined;
	try {
		const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as { readonly target?: string };
		if (typeof provenance.target === "string" && provenance.target !== expectedTarget) {
			return `payload target ${provenance.target} does not match ${expectedTarget}`;
		}
	} catch {
		// Older or externally supplied archives may not carry readable provenance.
	}
	return undefined;
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
	const candidates: readonly { readonly path?: string; readonly label: string; readonly validateTarget?: boolean }[] =
		[
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
				path:
					rootPackage.manifest === undefined ? undefined : join(dirname(rootPackage.manifest), "postgres-runtime"),
				label: packagedRuntimeCandidate("@bastani/atomic-natives", rootPackage),
				validateTarget: true,
			},
		];
	for (const candidate of candidates) {
		searched.push(candidate.label);
		if (candidate.path === undefined || !existsSync(candidate.path)) continue;
		if (candidate.validateTarget) {
			const mismatch = packagedRuntimeTargetMismatch(candidate.path, target.id);
			if (mismatch !== undefined) {
				searched[searched.length - 1] += ` (${mismatch})`;
				continue;
			}
		}
		try {
			return binariesFromDirectory(candidate.path, host.platform, options.readOnly);
		} catch (error) {
			searched[searched.length - 1] += ` (${error instanceof Error ? error.message : String(error)})`;
		}
	}

	if (target.npmPackageName !== undefined) {
		searched.push(target.npmPackageName);
		// Compiled Bun cannot import an unregistered bare package from a disk ESM
		// builtin, even when its bytes are installed. Manifest resolution still
		// works there: keep binary paths anchored to the package on disk.
		if (options.importPackage === undefined) {
			const legacy = resolvePackageManifest(target.npmPackageName, resolvePackage);
			if (legacy.manifest !== undefined) {
				try {
					return binariesFromDirectory(join(dirname(legacy.manifest), "native"), host.platform, options.readOnly);
				} catch {
					// Nonstandard/older wrappers retain their existing import API below.
				}
			}
		}
		try {
			const importPackage: PackageImporter = options.importPackage ?? (async (specifier) => await import(specifier));
			const binaries = await importPackage(target.npmPackageName);
			if (typeof binaries.pg_ctl !== "string" || typeof binaries.initdb !== "string") {
				throw new Error("package did not export pg_ctl/initdb paths");
			}
			const postgres = join(dirname(binaries.pg_ctl), host.platform === "win32" ? "postgres.exe" : "postgres");
			if (!options.readOnly)
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
	/** Test seam after this process created the lock directory and before it writes its owner marker. */
	readonly beforeOwnerMarkerWrite?: (lockDir: string) => void;
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
		lease = acquireSetupLock(lockDir, clock(), staleMs, isProcessAlive, options.beforeOwnerMarkerWrite);
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
	beforeOwnerMarkerWrite?: (lockDir: string) => void,
): SetupLockLease | undefined {
	const abandonedOwnerTokens = new Set<string>();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = `${process.pid}-${crypto.randomUUID()}`;
		if (createSetupLockDirectory(lockDir)) {
			beforeOwnerMarkerWrite?.(lockDir);
			const lease = claimCreatedSetupLock(lockDir, token, now, abandonedOwnerTokens);
			if (lease !== undefined) return lease;
		}

		const observation = observeSetupLock(lockDir);
		if (observation === undefined || !setupLockIsStale(observation, now, staleMs, isProcessAlive)) return undefined;
		const abandoned = breakStaleSetupLock(lockDir, observation, now, staleMs, token, isProcessAlive);
		if (abandoned === undefined) return undefined;
		for (const abandonedToken of abandoned) abandonedOwnerTokens.add(abandonedToken);
	}
	return undefined;
}

function createSetupLockDirectory(lockDir: string): boolean {
	try {
		mkdirSync(lockDir);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
}

/**
 * Write the owner marker into a directory this process just created. Until the
 * marker lands the directory is indistinguishable from an abandoned empty
 * lock, so a contender may displace it once it ages past the stale threshold.
 * That shows up here either as `ENOENT` (the directory is gone) or, when the
 * contender has already installed a replacement at the same path, as a marker
 * that landed beside another owner's. The pathname alone cannot tell the
 * original directory from its replacement, so ownership is established only
 * when this marker is the directory's sole entry after the write; anything
 * else is a lost race rather than a failure.
 */
function claimCreatedSetupLock(
	lockDir: string,
	token: string,
	now: HostLeaseTime,
	abandonedOwnerTokens: ReadonlySet<string>,
): SetupLockLease | undefined {
	const markerName = `.owner-${token}`;
	const markerPath = join(lockDir, markerName);
	try {
		writeFileSync(
			markerPath,
			serializeLockOwner({ token, pid: process.pid, heartbeatMonotonicMs: now.monotonicMs }),
			{
				flag: "wx",
				mode: 0o600,
			},
		);
	} catch (error) {
		try {
			rmdirSync(lockDir);
		} catch {
			// Unexpected content means ownership was never established.
		}
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (createdSetupLockHoldsOnly(lockDir, markerName)) {
		return { lockDir, markerPath, token, ownerPid: process.pid, abandonedOwnerTokens };
	}
	// The marker name is unique to this token, so removing it cannot touch the
	// other owner's record; rmdir is non-recursive and only succeeds if every
	// contender backed off, which leaves the path free for the next attempt.
	rmSync(markerPath, { force: true });
	try {
		rmdirSync(lockDir);
	} catch {
		// Another owner's marker keeps the directory: that lease stands.
	}
	return undefined;
}

function createdSetupLockHoldsOnly(lockDir: string, markerName: string): boolean {
	try {
		const entries = readdirSync(lockDir);
		return entries.length === 1 && entries[0] === markerName;
	} catch {
		return false;
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
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
	if (observation.hasUnexpectedState) {
		// Finite migration handling for malformed/legacy locks. A future mtime is
		// rollback evidence rather than a lease that can stay fresh indefinitely.
		return now.wallTimeMs < observation.latestMtimeMs || now.wallTimeMs - observation.latestMtimeMs > staleMs;
	}
	if (observation.owners.length > 0) return true;
	return emptySetupLockIsAbandoned(observation, now, staleMs);
}

/**
 * An owner-less directory is either a contender between `mkdir` and its marker
 * write or an abandoned legacy/crash remnant. Only age tells them apart, so a
 * future mtime fails closed: it cannot prove the directory old, and treating it
 * as stale would displace a live contender mid-acquisition.
 */
function emptySetupLockIsAbandoned(observation: LockObservation, now: HostLeaseTime, staleMs: number): boolean {
	return Number.isFinite(observation.latestMtimeMs) && now.wallTimeMs - observation.latestMtimeMs > staleMs;
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
	ensureCluster,
	ensure: ensureEmbeddedDbosPostgres,
	setActiveCluster: setActiveClusterForTests,
	setEnsureOperation: setEnsureOperationForTests,
	setRetainedPostgresSpawner: setRetainedPostgresSpawnerForTests,
	startCluster,
	waitForClusterReadiness,
	withSetupLock,
};

export function resetEmbeddedDbosPostgresForTests(): void {
	void health?.stop();
	health = undefined;
	ensured = undefined;
	actualPort = EMBEDDED_PORT;
	consumer?.release();
	consumer = undefined;
	initializing = false;
	activeCluster?.lease.release();
	activeCluster = undefined;
	ensureOperation = ensure;
	retainedPostgresSpawnerOverride = undefined;
}
