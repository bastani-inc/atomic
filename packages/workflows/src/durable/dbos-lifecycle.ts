import { type ConfiguredDbosDurability, configureDbosDurableBackend, type DbosDurableBackend } from "./dbos-backend.js";
import {
	provisionResolvedLocalDbos,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
	shutdownResolvedLocalDbos,
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
type LocalDbosShutdowner = () => Promise<void>;

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
let shutdownLocalDbos: LocalDbosShutdowner = shutdownResolvedLocalDbos;

function owner(): ReturnType<typeof getDbosProcessOwner> {
	return getDbosProcessOwner();
}

async function durabilityFailure(action: string, error: unknown): Promise<DbosDurabilityError> {
	const detail = readDbosFailureDetail(error);
	const kind = await classifyDbosDurabilityFailure(error);
	const guidance =
		kind === "duplicate_registration"
			? "A duplicate DBOS operation registration caused this failure; changing the database URL will not resolve it."
			: "Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres when local provisioning is unavailable.";
	const cause = error instanceof Error ? { cause: error } : undefined;
	return new DbosDurabilityError(`DBOS workflow durability ${action} failed: ${detail}. ${guidance}`, cause);
}

function combinedShutdownFailure(errors: readonly unknown[]): unknown {
	if (errors.length === 1) return errors[0];
	return new AggregateError(errors, errors.map((error) => readDbosFailureDetail(error)).join("; "));
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
		.catch(async (error: unknown) => {
			slot.failure = await durabilityFailure("configuration", error);
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
					slot.failure = await durabilityFailure("local Postgres startup", provisionError);
				}
			} else {
				slot.failure = await durabilityFailure("launch", error);
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
		// Configuration and launch failures are intentionally not rethrown during
		// session disposal, but local provisioning may already have started an
		// owned cluster. Always attempt that cleanup exactly once.
		const durability = await configuredPromise.catch(() => undefined);
		if (durability === undefined) {
			await shutdownLocalDbos();
			return;
		}
		if (slot.launchPromise !== undefined) await slot.launchPromise.catch(() => undefined);
		if (slot.state !== "ready") {
			await shutdownLocalDbos();
			return;
		}
		slot.state = "shutting_down";
		const errors: unknown[] = [];
		for (const shutdown of [() => durability.backend.flush(), () => durability.shutdown(), shutdownLocalDbos]) {
			try {
				await shutdown();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw combinedShutdownFailure(errors);
		slot.state = "shut_down";
	})().catch(async (error: unknown) => {
		slot.failure = await durabilityFailure("shutdown", error);
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
	shutdowner: LocalDbosShutdowner = shutdownResolvedLocalDbos,
): void {
	resetDbosProcessOwner();
	configureDurability = configurator;
	provisionLocalDbos = provisioner;
	shutdownLocalDbos = shutdowner;
}
