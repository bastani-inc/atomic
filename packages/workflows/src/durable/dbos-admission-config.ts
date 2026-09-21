import { ensurePGDatabase } from "@dbos-inc/dbos-sdk/datasource";
import { fenceDbosAdmissionPool } from "./dbos-admission-pool.js";
import { defaultPostgresUrl } from "./dbos-default-postgres-url.js";
import { resolvedPostgresHealth } from "./dbos-managed-health.js";
import { createRecoverablePostgresPool } from "./dbos-recoverable-pool.js";
import type { DbosConfiguration, DbosStatic } from "./dbos-sdk-handle.js";

/** Preserve DBOS's default endpoint when the Docker fallback supplies no URL. */
function defaultDatabaseUrl(name: string): string {
	// Match DBOS's application-name normalization, including a leading digit.
	const database = name.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_").replace(/^\d/, "_$&");
	return defaultPostgresUrl(`${database}_dbos_sys`);
}

export function configureAdmissionDatabase(
	sdk: Pick<DbosStatic, "setConfig" | "launch">,
	config: DbosConfiguration,
): { launch: () => Promise<void>; checkReady: () => Promise<void> } {
	const systemDatabaseUrl = config.systemDatabaseUrl ?? defaultDatabaseUrl(config.name);
	const health = resolvedPostgresHealth(systemDatabaseUrl);
	const createPool = () => {
		let unsubscribe: (() => void) | undefined;
		const managed = createRecoverablePostgresPool(systemDatabaseUrl, {
			beforeConnect: health === undefined ? undefined : () => health.check(),
			afterConnect: health === undefined ? undefined : (client) => health.validate(client),
			onConnectionError: () => health?.invalidate(),
			onEnd: () => unsubscribe?.(),
		});
		unsubscribe = health?.subscribe(managed.invalidate);
		health?.start();
		return fenceDbosAdmissionPool(managed.pool);
	};
	let pool = createPool();
	sdk.setConfig({ ...config, systemDatabaseUrl, systemDatabasePool: pool });
	const launch = async (): Promise<void> => {
		// DBOS closes custom pools on shutdown, including the failed-launch retry.
		if (pool.ended) {
			pool = createPool();
			sdk.setConfig({ ...config, systemDatabaseUrl, systemDatabasePool: pool });
		}
		// DBOS skips database creation with a custom pool. Keep its existing
		// ensure-database behavior via the public datasource API, never reset data.
		const urlToEnsure = health === undefined ? systemDatabaseUrl : await health.check();
		const result = await ensurePGDatabase({ urlToEnsure, logger: () => {} });
		if (result.status === "failed") {
			config.logger.warn("Workflow database could not be verified or created; attempting DBOS launch.");
		}
		await sdk.launch();
	};
	return {
		launch,
		// Called inside the admission context so its deadline also fences SQL retries.
		checkReady: async () => {
			await pool.query("SELECT 1");
		},
	};
}
