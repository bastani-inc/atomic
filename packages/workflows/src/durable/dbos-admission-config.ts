import { ensurePGDatabase, getPGClientConfig } from "@dbos-inc/dbos-sdk/datasource";
import { Pool } from "pg";
import { fenceDbosAdmissionPool } from "./dbos-admission-pool.js";
import type { DbosConfiguration, DbosStatic } from "./dbos-sdk-handle.js";

/** Preserve DBOS's default endpoint when the Docker fallback supplies no URL. */
function defaultDatabaseUrl(name: string): string {
	// Match DBOS's application-name normalization, including a leading digit.
	const database = name.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_").replace(/^\d/, "_$&");
	const url = new URL("postgresql://localhost");
	url.pathname = `/${database}_dbos_sys`;
	url.hostname = process.env.PGHOST || "localhost";
	url.port = process.env.PGPORT || "5432";
	url.username = process.env.PGUSER || "postgres";
	url.password = process.env.PGPASSWORD || "dbos";
	url.searchParams.set("connect_timeout", process.env.PGCONNECT_TIMEOUT || "10");
	url.searchParams.set("sslmode", process.env.PGSSLMODE || (url.hostname === "localhost" ? "disable" : "allow"));
	return url.toString();
}

export function configureAdmissionDatabase(
	sdk: Pick<DbosStatic, "setConfig" | "launch">,
	config: DbosConfiguration,
): { launch: () => Promise<void>; checkReady: () => Promise<void> } {
	const systemDatabaseUrl = config.systemDatabaseUrl ?? defaultDatabaseUrl(config.name);
	let pool = fenceDbosAdmissionPool(new Pool(getPGClientConfig(systemDatabaseUrl)));
	sdk.setConfig({ ...config, systemDatabaseUrl, systemDatabasePool: pool });
	const launch = async (): Promise<void> => {
		// DBOS closes custom pools on shutdown, including the failed-launch retry.
		if (pool.ended) {
			pool = fenceDbosAdmissionPool(new Pool(getPGClientConfig(systemDatabaseUrl)));
			sdk.setConfig({ ...config, systemDatabaseUrl, systemDatabasePool: pool });
		}
		// DBOS skips database creation with a custom pool. Keep its existing
		// ensure-database behavior via the public datasource API, never reset data.
		const result = await ensurePGDatabase({ urlToEnsure: systemDatabaseUrl, logger: () => {} });
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
