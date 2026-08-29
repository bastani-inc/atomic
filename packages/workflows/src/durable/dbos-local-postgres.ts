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

import {
	EMBEDDED_DBOS_SYSTEM_DATABASE_URL,
	EmbeddedPostgresCleanupPendingError,
	ensureEmbeddedDbosPostgres,
	shutdownEmbeddedDbosPostgres,
} from "./dbos-embedded-postgres.js";
import { commandFailureDetail, delay, runLocalCommand, tcpReachable } from "./local-command.js";

const DOCKER_CONTAINER = "dbos-db";
const DOCKER_IMAGE = "pgvector/pgvector:pg16";
const DOCKER_READY_ATTEMPTS = 60;
const DOCKER_READY_DELAY_MS = 500;

type LocalDbosProvider = () => Promise<void>;
type LocalDbosShutdowner = () => Promise<void>;

let resolution: Promise<string | undefined> | undefined;
let resolvedProvider: LocalDbosProvider | undefined;
let embeddedProvider: LocalDbosProvider = ensureEmbeddedDbosPostgres;
let dockerProvider: LocalDbosProvider = ensureDockerDbosPostgres;
let shutdownEmbeddedProvider: LocalDbosShutdowner = shutdownEmbeddedDbosPostgres;
let embeddedShutdown: Promise<void> | undefined;
let settingsSystemDatabaseUrl: string | undefined;

export function setDbosSystemDatabaseUrlSetting(url: string | undefined): void {
	settingsSystemDatabaseUrl = url;
	resolution = undefined;
}

/**
 * Resolve the system database URL for this process and make its database
 * reachable. `undefined` defers to the environment/DBOS defaults (explicit
 * user URL or the Docker container that matches them).
 */
export function resolveDbosSystemDatabaseUrl(): Promise<string | undefined> {
	resolution ??= resolve().catch((error: unknown) => {
		resolution = undefined;
		throw error;
	});
	return resolution;
}

/** Re-ensure the previously resolved local database (launch-retry safety net). */
export async function provisionResolvedLocalDbos(): Promise<void> {
	await (resolvedProvider ?? embeddedProvider)();
}

/** Stop the local database only when the resolved provider was embedded. */
export function shutdownResolvedLocalDbos(): Promise<void> {
	if (resolvedProvider !== embeddedProvider) return Promise.resolve();
	embeddedShutdown ??= shutdownEmbeddedProvider().then(
		() => {
			resolvedProvider = undefined;
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
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim() || settingsSystemDatabaseUrl?.trim()) return false;
	const message = error instanceof Error ? `${error.message}\n${error.cause ?? ""}` : String(error);
	return /ECONNREFUSED|server not reachable|connect failed|connection refused|unable to connect to system database/i.test(
		message,
	);
}

async function resolve(): Promise<string | undefined> {
	if (process.env.DBOS_SYSTEM_DATABASE_URL?.trim()) return undefined;
	const settingsUrl = settingsSystemDatabaseUrl?.trim();
	if (settingsUrl) return settingsUrl;

	try {
		await embeddedProvider();
		resolvedProvider = embeddedProvider;
		return EMBEDDED_DBOS_SYSTEM_DATABASE_URL;
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
			"127.0.0.1:5432:5432",
			"-v",
			"dbos-db-data:/var/lib/postgresql/data",
			DOCKER_IMAGE,
		]);
	}

	for (let attempt = 0; attempt < DOCKER_READY_ATTEMPTS; attempt += 1) {
		if (await tcpReachable("127.0.0.1", 5432)) return;
		await delay(DOCKER_READY_DELAY_MS);
	}
	throw new Error("The DBOS Postgres container started but did not become ready within 30 seconds.");
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
	settingsUrl?: string,
): void {
	resolution = undefined;
	resolvedProvider = undefined;
	embeddedShutdown = undefined;
	embeddedProvider = embedded;
	dockerProvider = docker;
	shutdownEmbeddedProvider = shutdownEmbedded;
	settingsSystemDatabaseUrl = settingsUrl;
}
