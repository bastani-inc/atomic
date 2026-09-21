/**
 * Local DBOS database resolution.
 *
 * Without `DBOS_SYSTEM_DATABASE_URL`, Atomic never guesses at a user-managed
 * Postgres (a reachable 5432 with foreign credentials is indistinguishable
 * from a misconfiguration). The order is deterministic:
 *
 *   1. `DBOS_SYSTEM_DATABASE_URL` — the user's explicit database.
 *   2. Atomic's embedded Postgres (npm-distributed binaries, no Docker).
 *   3. DBOS's reusable `dbos-db` Docker container, only after embedded
 *      provisioning fails without leaving retained-process cleanup pending.
 */

import { Client } from "pg";
import { defaultPostgresUrl } from "./dbos-default-postgres-url.js";
import {
	EmbeddedPostgresCleanupPendingError,
	embeddedDbosSystemDatabaseUrl,
	embeddedPostgresHealth,
	embeddedPostgresLastFailure,
	ensureEmbeddedDbosPostgres,
	recoverEmbeddedPostgres,
	shutdownEmbeddedDbosPostgres,
} from "./dbos-embedded-postgres.js";
import type { EmbeddedPostgresRunContext } from "./dbos-embedded-postgres-root.js";
import type { ManagedPostgresMetadata } from "./dbos-postgres-ownership.js";
import { commandFailureDetail, delay, runLocalCommand } from "./local-command.js";

const DOCKER_CONTAINER = "dbos-db";
const DOCKER_IMAGE = "pgvector/pgvector:pg16";
const DOCKER_READY_ATTEMPTS = 60;
const DOCKER_READY_DELAY_MS = 500;
const DOCKER_READY_QUERY_TIMEOUT_MS = 1_000;
const TRANSIENT_STARTUP_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"57P01",
	"57P02",
	"57P03",
]);

type LocalDbosProvider = () => Promise<void>;
type LocalDbosShutdowner = () => Promise<void>;

let resolution: Promise<string | undefined> | undefined;
let resolvedProvider: LocalDbosProvider | undefined;
let embeddedProvider: LocalDbosProvider = ensureEmbeddedDbosPostgres;
let dockerProvider: LocalDbosProvider = ensureDockerDbosPostgres;
let shutdownEmbeddedProvider: LocalDbosShutdowner = shutdownEmbeddedDbosPostgres;
let embeddedShutdown: Promise<void> | undefined;

// The DBOS owner survives bundle reload. Keep its provider and cleanup closure
// in the same process lifetime rather than selecting a fresh generation's memo.
interface LocalDbosOwner {
	resolve: typeof resolveDbosSystemDatabaseUrl;
	provision: typeof provisionResolvedLocalDbos;
	shutdown: typeof shutdownResolvedLocalDbos;
}
// Optional on predecessor owners; never create a second provider after reload.
type HealthOwner = LocalDbosOwner & {
	health?: typeof resolvedPostgresHealth;
	provider?: typeof resolvedPostgresProvider;
	failure?: typeof postgresLastFailure;
	recover?: typeof recoverManagedPostgres;
};
const ownerKey = Symbol.for("atomic-workflows/local-postgres-owner@1");
const ownerBag = globalThis as typeof globalThis & Record<symbol, HealthOwner | undefined>;
const owner = ownerBag[ownerKey] ?? {
	resolve: resolveDbosSystemDatabaseUrl,
	provision: provisionResolvedLocalDbos,
	shutdown: shutdownResolvedLocalDbos,
	health: resolvedPostgresHealth,
	provider: resolvedPostgresProvider,
	failure: postgresLastFailure,
	recover: recoverManagedPostgres,
};
ownerBag[ownerKey] = owner;

export function resolvedPostgresProvider(): "embedded" | "docker" | "unresolved" {
	if (owner.provider !== resolvedPostgresProvider) return owner.provider?.() ?? "unresolved";
	return resolvedProvider === embeddedProvider
		? "embedded"
		: resolvedProvider === dockerProvider
			? "docker"
			: "unresolved";
}

export function postgresLastFailure(): Error | undefined {
	if (owner.failure !== postgresLastFailure) return owner.failure?.();
	return embeddedPostgresLastFailure();
}

export async function recoverManagedPostgres(
	context: EmbeddedPostgresRunContext,
	metadata: ManagedPostgresMetadata,
): Promise<void> {
	if (owner.recover !== recoverManagedPostgres) {
		if (!owner.recover)
			throw new Error(
				"Reloaded PostgreSQL owner does not support explicit recovery. Restart Atomic without deleting data.",
			);
		return owner.recover(context, metadata);
	}
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim() || resolvedProvider === dockerProvider)
		throw new Error("Managed recovery is not allowed for the selected provider.");
	resolvedPostgresHealth()?.invalidate();
	try {
		await recoverEmbeddedPostgres(context, metadata);
		resolvedProvider = embeddedProvider;
	} catch (error) {
		if (error instanceof EmbeddedPostgresCleanupPendingError) resolvedProvider = embeddedProvider;
		throw error;
	}
}

/** Only a resolved managed provider grants automatic recovery authority. */
export function resolvedPostgresHealth(url?: string): ReturnType<typeof embeddedPostgresHealth> {
	if (owner.health !== resolvedPostgresHealth) return owner.health?.(url);
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim() || resolvedProvider !== embeddedProvider) return undefined;
	if (url !== undefined && url !== embeddedDbosSystemDatabaseUrl()) return undefined;
	return embeddedPostgresHealth();
}
/**
 * Resolve the system database URL for this process and make its database
 * reachable. `undefined` defers to the environment/DBOS defaults (explicit
 * user URL or the Docker container that matches them).
 */
export function resolveDbosSystemDatabaseUrl(): Promise<string | undefined> {
	if (owner.resolve !== resolveDbosSystemDatabaseUrl) return owner.resolve();
	const health = resolvedPostgresHealth();
	if (health !== undefined) return health.check();
	resolution ??= resolve().catch((error: unknown) => {
		resolution = undefined;
		throw error;
	});
	return resolution;
}

/** Re-ensure the previously resolved local database (launch-retry safety net). */
export async function provisionResolvedLocalDbos(): Promise<void> {
	if (owner.provision !== provisionResolvedLocalDbos) return owner.provision();
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim()) return;
	await (resolvedProvider ?? embeddedProvider)();
}

/** Stop the local database only when the resolved provider was embedded. */
export function shutdownResolvedLocalDbos(): Promise<void> {
	if (owner.shutdown !== shutdownResolvedLocalDbos) return owner.shutdown();
	if (resolvedProvider !== embeddedProvider) return Promise.resolve();
	embeddedShutdown ??= shutdownEmbeddedProvider().then(
		() => {
			resolvedProvider = undefined;
			resolution = undefined;
			embeddedShutdown = undefined;
		},
		(error: unknown) => {
			embeddedShutdown = undefined;
			throw error;
		},
	);
	return embeddedShutdown;
}

export function shouldProvisionLocalDbos(error: unknown): boolean {
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim()) return false;
	if (isTransientStartupError(error)) return true;
	const message = error instanceof Error ? `${error.message}\n${error.cause ?? ""}` : String(error);
	return /server not reachable|connect failed|connection refused|unable to connect to system database/i.test(message);
}

function postgresReadinessPort(value: string | number): number {
	const port = Number(value);
	const validFormat = typeof value !== "string" || /^\d+$/.test(value);
	const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
	if (!validFormat || !validPort)
		throw new Error("PostgreSQL readiness port (PGPORT) must be an integer between 1 and 65535.");
	return port;
}

/** Host/port/user/password DBOS uses when the Docker fallback supplies no URL. */
export function dockerFallbackEndpoint(): {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly password: string;
} {
	return {
		host: process.env.PGHOST || "localhost",
		port: postgresReadinessPort(process.env.PGPORT || "5432"),
		user: process.env.PGUSER || "postgres",
		password: process.env.PGPASSWORD || "dbos",
	};
}

export type PostgresReadinessProbe = (host: string, port: number) => Promise<boolean>;

export interface PostgresProtocolReadinessOptions {
	readonly host: string;
	readonly port: number;
	readonly isReady?: PostgresReadinessProbe;
	readonly attempts?: number;
	readonly delayMs?: number;
	readonly wait?: (ms: number) => Promise<void>;
}

/** Wait until PostgreSQL on host:port answers a query, or the bounded deadline expires. */
export async function waitForPostgresProtocolReadiness(options: PostgresProtocolReadinessOptions): Promise<void> {
	postgresReadinessPort(options.port);
	const attempts = options.attempts ?? DOCKER_READY_ATTEMPTS;
	const delayMs = options.delayMs ?? DOCKER_READY_DELAY_MS;
	const wait = options.wait ?? delay;
	const isReady = options.isReady ?? dockerPostgresQueryReady;
	const deadline = performance.now() + attempts * delayMs;
	for (let attempt = 0; attempt < attempts && performance.now() < deadline; attempt += 1) {
		try {
			if (await isReady(options.host, options.port)) return;
		} catch (error) {
			if (!isTransientStartupError(error)) throw error;
		}
		if (attempt + 1 < attempts && performance.now() < deadline) await wait(delayMs);
	}
	throw new Error(
		`The DBOS Postgres container started but did not become ready within ${(attempts * delayMs) / 1000} seconds.`,
	);
}

function isTransientStartupError(error: unknown): boolean {
	const seen = new Set<Error>();
	let current = error;
	while (current !== undefined) {
		const code = current instanceof Error && "code" in current ? current.code : undefined;
		if (typeof code === "string" && TRANSIENT_STARTUP_CODES.has(code)) return true;
		if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return false;
		const message = current instanceof Error ? current.message : String(current);
		if (
			/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|^connection (?:refused|terminated(?: unexpectedly| due to connection timeout)?)(?:\s|$)|^connect(?:ion)? (?:timeout|timed out)(?:\s|$)|^timeout (?:expired|exceeded when trying to connect)$/i.test(
				message,
			)
		)
			return true;
		if (!(current instanceof Error) || seen.has(current)) return false;
		seen.add(current);
		current = current.cause;
	}
	return false;
}

async function dockerPostgresQueryReady(host: string, port: number): Promise<boolean> {
	const client = new Client({
		connectionString: defaultPostgresUrl("postgres", host, String(port)),
		connectionTimeoutMillis: DOCKER_READY_QUERY_TIMEOUT_MS,
		query_timeout: DOCKER_READY_QUERY_TIMEOUT_MS,
		statement_timeout: DOCKER_READY_QUERY_TIMEOUT_MS,
	});
	client.on("error", () => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				await client.connect();
				await client.query("SELECT 1");
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout expired")), DOCKER_READY_QUERY_TIMEOUT_MS);
			}),
		]);
		return true;
	} catch (error) {
		if (isTransientStartupError(error)) return false;
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		client.end().catch(() => undefined);
	}
}

async function resolve(): Promise<string | undefined> {
	const explicit = process.env.DBOS_SYSTEM_DATABASE_URL?.trim();
	if (explicit) return undefined;

	try {
		await embeddedProvider();
		resolvedProvider = embeddedProvider;
		return embeddedDbosSystemDatabaseUrl();
	} catch (embeddedError) {
		if (embeddedError instanceof EmbeddedPostgresCleanupPendingError) {
			// A second database must not hide the exact child lease whose startup
			// rollback timed out. Keep teardown routed to that embedded owner.
			resolvedProvider = embeddedProvider;
			throw embeddedError;
		}
		try {
			await dockerProvider();
			resolvedProvider = dockerProvider;
			// The container matches DBOS's documented default URL; defer to it.
			return undefined;
		} catch (dockerError) {
			const embeddedDetail = embeddedError instanceof Error ? embeddedError.message : String(embeddedError);
			const dockerDetail = dockerError instanceof Error ? dockerError.message : String(dockerError);
			throw new Error(
				`No usable Postgres for workflow durability. Embedded Postgres: ${embeddedDetail} Docker fallback: ${dockerDetail} ` +
					"Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres to proceed.",
			);
		}
	}
}

/** Start DBOS's canonical reusable local Postgres container. */
async function ensureDockerDbosPostgres(): Promise<void> {
	const endpoint = dockerFallbackEndpoint();
	const docker = await runLocalCommand("docker", ["version", "--format", "{{.Server.Version}}"]).catch(
		() => undefined,
	);
	if (docker === undefined || docker.exitCode !== 0) {
		throw new Error("Docker is unavailable.");
	}

	const inspection = await runLocalCommand("docker", ["inspect", "--format", "{{.State.Running}}", DOCKER_CONTAINER]);
	if (inspection.exitCode === 0) {
		if (inspection.stdout.trim() !== "true") {
			await requireDockerSuccess("start existing DBOS Postgres", ["start", DOCKER_CONTAINER]);
		}
	} else {
		await requireDockerSuccess("create DBOS Postgres", [
			"run",
			"-d",
			"--name",
			DOCKER_CONTAINER,
			"-e",
			"POSTGRES_PASSWORD=dbos",
			"-e",
			"PGDATA=/var/lib/postgresql/data",
			"-p",
			`127.0.0.1:${endpoint.port}:5432`,
			"-v",
			"dbos-db-data:/var/lib/postgresql/data",
			DOCKER_IMAGE,
		]);
	}

	await waitForPostgresProtocolReadiness({ host: endpoint.host, port: endpoint.port });
}

async function requireDockerSuccess(action: string, args: string[]): Promise<void> {
	const result = await runLocalCommand("docker", args);
	if (result.exitCode === 0) return;
	throw new Error(`Could not ${action}: ${commandFailureDetail(result)}`);
}

export function resetLocalDbosProvisioningForTests(
	embedded: LocalDbosProvider = ensureEmbeddedDbosPostgres,
	docker: LocalDbosProvider = ensureDockerDbosPostgres,
	shutdownEmbedded: LocalDbosShutdowner = shutdownEmbeddedDbosPostgres,
): void {
	Object.assign(owner, {
		resolve: resolveDbosSystemDatabaseUrl,
		provision: provisionResolvedLocalDbos,
		shutdown: shutdownResolvedLocalDbos,
		health: resolvedPostgresHealth,
		provider: resolvedPostgresProvider,
		failure: postgresLastFailure,
		recover: recoverManagedPostgres,
	});
	resolution = undefined;
	resolvedProvider = undefined;
	embeddedShutdown = undefined;
	embeddedProvider = embedded;
	dockerProvider = docker;
	shutdownEmbeddedProvider = shutdownEmbedded;
}
