import {
  configureDbosDurableBackend,
  type ConfiguredDbosDurability,
  type DbosDurableBackend,
} from "./dbos-backend.js";
import {
  provisionResolvedLocalDbos,
  resolveDbosSystemDatabaseUrl,
  shouldProvisionLocalDbos,
} from "./dbos-local-postgres.js";

export type DbosLifecycleState =
  | "uninitialized"
  | "configured"
  | "launching"
  | "ready"
  | "failed"
  | "shutting_down";

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
type DbosConfigurator = () => Promise<ConfiguredDbosDurability>;
type LocalDbosProvisioner = () => Promise<void>;

/**
 * Default path: resolve the local database first (explicit env URL, embedded
 * Postgres, or the Docker fallback), then configure DBOS against it.
 */
const defaultConfigurator: DbosConfigurator = async () => {
  const systemDatabaseUrl = await resolveDbosSystemDatabaseUrl();
  return await configureDbosDurableBackend(
    systemDatabaseUrl === undefined ? undefined : { systemDatabaseUrl },
  );
};

let configureDurability: DbosConfigurator = defaultConfigurator;
let provisionLocalDbos: LocalDbosProvisioner = provisionResolvedLocalDbos;

let state: DbosLifecycleState = "uninitialized";
let configured: Promise<ConfiguredDbosDurability> | undefined;
let active: ConfiguredDbosDurability | undefined;
let launchPromise: Promise<void> | undefined;
let shutdownPromise: Promise<void> | undefined;
let failure: DbosDurabilityError | undefined;

function durabilityFailure(action: string, error: unknown): DbosDurabilityError {
  const detail = error instanceof Error ? error.message : String(error);
  return new DbosDurabilityError(
    `DBOS workflow durability ${action} failed: ${detail}. Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres when local provisioning is unavailable.`,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export async function configureDbosOnce(): Promise<ConfiguredDbosDurability> {
  if (failure !== undefined) throw failure;
  configured ??= configureDurability().then((value) => {
    active = value;
    state = "configured";
    return value;
  }).catch((error: unknown) => {
    failure = durabilityFailure("configuration", error);
    state = "failed";
    throw failure;
  });
  return await configured;
}

export async function launchDbosOnce(): Promise<void> {
  if (failure !== undefined) throw failure;
  const durability = await configureDbosOnce();
  launchPromise ??= (async () => {
    state = "launching";
    try {
      await durability.launch();
      state = "ready";
    } catch (error) {
      if (shouldProvisionLocalDbos(error)) {
        try {
          // DBOS creates an executor before testing connectivity. Tear down the
          // failed executor so retry does not leak a pool or hang shutdown.
          await durability.shutdown();
          await provisionLocalDbos();
          await durability.launch();
          state = "ready";
          return;
        } catch (provisionError) {
          failure = durabilityFailure("local Postgres startup", provisionError);
        }
      } else {
        failure = durabilityFailure("launch", error);
      }
      state = "failed";
      throw failure;
    }
  })();
  await launchPromise;
}

export async function getReadyDbosBackend(): Promise<DbosDurableBackend> {
  await launchDbosOnce();
  if (state !== "ready" || active === undefined) throw failure ?? new DbosNotReadyError();
  return active.backend;
}

export function getReadyDbosBackendSync(): DbosDurableBackend | undefined {
  return state === "ready" ? active?.backend : undefined;
}

export async function shutdownDbos(): Promise<void> {
  if (shutdownPromise !== undefined) return await shutdownPromise;
  const configuredPromise = configured;
  if (configuredPromise === undefined) return;
  shutdownPromise = (async () => {
    // A backend that never reached "ready" has nothing to flush or stop.
    // `configured`/`launchPromise` memoize rejections, so re-awaiting them
    // unguarded would rethrow the original provisioning failure out of every
    // session dispose — crashing otherwise-successful runs at process exit.
    const durability = await configuredPromise.catch(() => undefined);
    if (durability === undefined) return;
    if (launchPromise !== undefined) await launchPromise.catch(() => undefined);
    if (state !== "ready") return;
    state = "shutting_down";
    await durability.backend.flush();
    await durability.shutdown();
  })().catch((error: unknown) => {
    failure = durabilityFailure("shutdown", error);
    state = "failed";
    throw failure;
  });
  await shutdownPromise;
}

export function dbosLifecycleState(): DbosLifecycleState {
  return state;
}

/** Reset the process singleton with an explicit configurator for unit tests. */
export function resetDbosLifecycleForTests(
  configurator: DbosConfigurator = defaultConfigurator,
  provisioner: LocalDbosProvisioner = provisionResolvedLocalDbos,
): void {
  state = "uninitialized";
  configured = undefined;
  active = undefined;
  launchPromise = undefined;
  shutdownPromise = undefined;
  failure = undefined;
  configureDurability = configurator;
  provisionLocalDbos = provisioner;
}
