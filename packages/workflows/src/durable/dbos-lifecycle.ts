import { type ConfiguredDbosDurability, configureDbosDurableBackend, type DbosDurableBackend } from "./dbos-backend.js";
import {
	provisionResolvedLocalDbos,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
} from "./dbos-local-postgres.js";
import { getDbosProcessOwner, resetDbosProcessOwner } from "./dbos-process-owner.js";
import { classifyDbosDurabilityFailure, readDbosFailureDetail } from "./dbos-registration-diagnostics.js";

export type DbosLifecycleState =
	| "uninitialized"
	| "configured"
	| "launching"
	| "ready"
	| "failed"
	| "shutting_down"
	| "shut_down";

export class DbosDurabilityError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DbosDurabilityError";
	}
}

export class DbosNotReadyError extends DbosDurabilityError {
	constructor() {
		super("DBOS workflow durability is not ready. Await initializeDurableBackend() before accessing workflows.");
		this.name = "DbosNotReadyError";
	}
}

export class DbosShutdownError extends DbosDurabilityError {
	constructor() {
		super(
			"DBOS workflow durability has been shut down in this process. " +
				"Durable workflows can no longer start; restart Atomic to restore durability.",
		);
		this.name = "DbosShutdownError";
	}
}
type DbosConfigurator = () => Promise<ConfiguredDbosDurability>;
type LocalDbosProvisioner = () => Promise<void>;

/**
 * Default path: resolve the local database first (explicit env URL, embedded
 * Postgres, or the Docker fallback), then configure DBOS against it.
 */
const defaultConfigurator: DbosConfigurator = async () => {
	const systemDatabaseUrl = await resolveDbosSystemDatabaseUrl();
	return await configureDbosDurableBackend(systemDatabaseUrl === undefined ? undefined : { systemDatabaseUrl });
};

let configureDurability: DbosConfigurator = defaultConfigurator;
let provisionLocalDbos: LocalDbosProvisioner = provisionResolvedLocalDbos;

function owner(): ReturnType<typeof getDbosProcessOwner> {
	return getDbosProcessOwner();
}

function durabilityFailure(action: string, error: unknown): DbosDurabilityError {
	const detail = readDbosFailureDetail(error);
	const guidance =
		classifyDbosDurabilityFailure(error) === "duplicate_registration"
			? "A duplicate DBOS operation registration caused this failure; changing the database URL will not resolve it."
			: "Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres when local provisioning is unavailable.";
	const cause = error instanceof Error ? { cause: error } : undefined;
	return new DbosDurabilityError(`DBOS workflow durability ${action} failed: ${detail}. ${guidance}`, cause);
}

export async function configureDbosOnce(): Promise<ConfiguredDbosDurability> {
	const slot = owner();
	if (slot.failure !== undefined) throw slot.failure;
	slot.configured ??= configureDurability()
		.then((value) => {
			slot.active = value;
			slot.state = "configured";
			return value;
		})
		.catch((error: unknown) => {
			slot.failure = durabilityFailure("configuration", error);
			slot.state = "failed";
			throw slot.failure;
		});
	return await slot.configured;
}

export async function launchDbosOnce(): Promise<void> {
	const slot = owner();
	if (slot.failure !== undefined) throw slot.failure;
	// The executor is process-scoped and stops exactly once, at process exit.
	// Post-shutdown launches must fail loudly instead of returning a backend
	// whose SDK launched marker has been cleared.
	if (slot.state === "shutting_down" || slot.state === "shut_down") throw new DbosShutdownError();
	const durability = await configureDbosOnce();
	slot.launchPromise ??= (async () => {
		slot.state = "launching";
		try {
			await durability.launch();
			slot.state = "ready";
		} catch (error) {
			if (shouldProvisionLocalDbos(error)) {
				try {
					// DBOS creates an executor before testing connectivity. Tear down the
					// failed executor so retry does not leak a pool or hang shutdown.
					await durability.shutdown();
					await provisionLocalDbos();
					await durability.launch();
					slot.state = "ready";
					return;
				} catch (provisionError) {
					slot.failure = durabilityFailure("local Postgres startup", provisionError);
				}
			} else {
				slot.failure = durabilityFailure("launch", error);
			}
			slot.state = "failed";
			throw slot.failure;
		}
	})();
	await slot.launchPromise;
}

export async function getReadyDbosBackend(): Promise<DbosDurableBackend> {
	await launchDbosOnce();
	const slot = owner();
	if (slot.state !== "ready" || slot.active === undefined) throw slot.failure ?? new DbosNotReadyError();
	return slot.active.backend;
}

export function getReadyDbosBackendSync(): DbosDurableBackend | undefined {
	const slot = owner();
	return slot.state === "ready" ? slot.active?.backend : undefined;
}

export async function shutdownDbos(): Promise<void> {
	const slot = owner();
	if (slot.shutdownPromise !== undefined) return await slot.shutdownPromise;
	const configuredPromise = slot.configured;
	if (configuredPromise === undefined) return;
	slot.shutdownPromise = (async () => {
		// A backend that never reached "ready" has nothing to flush or stop.
		// `configured`/`launchPromise` memoize rejections, so re-awaiting them
		// unguarded would rethrow the original provisioning failure out of every
		// session dispose — crashing otherwise-successful runs at process exit.
		const durability = await configuredPromise.catch(() => undefined);
		if (durability === undefined) return;
		if (slot.launchPromise !== undefined) await slot.launchPromise.catch(() => undefined);
		if (slot.state !== "ready") return;
		slot.state = "shutting_down";
		await durability.backend.flush();
		await durability.shutdown();
		slot.state = "shut_down";
	})().catch((error: unknown) => {
		slot.failure = durabilityFailure("shutdown", error);
		slot.state = "failed";
		throw slot.failure;
	});
	await slot.shutdownPromise;
}

/**
 * Flush queued durable writes without stopping the process-scoped executor.
 * Used at process-preserving host-session boundaries (`/new`, `/resume`,
 * `/fork`, `/reload`) where the DBOS executor must stay launched.
 */
export async function flushDbos(): Promise<void> {
	const slot = owner();
	if (slot.state !== "ready" || slot.active === undefined) return;
	await slot.active.backend.flush();
}

export function dbosLifecycleState(): DbosLifecycleState {
	return owner().state;
}

/** Reset the process singleton with an explicit configurator for unit tests. */
export function resetDbosLifecycleForTests(
	configurator: DbosConfigurator = defaultConfigurator,
	provisioner: LocalDbosProvisioner = provisionResolvedLocalDbos,
): void {
	resetDbosProcessOwner();
	configureDurability = configurator;
	provisionLocalDbos = provisioner;
}
