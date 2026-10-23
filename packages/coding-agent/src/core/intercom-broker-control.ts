import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getBuiltinPackageLocations } from "./builtin-packages.ts";
import type { SqliteExecutor } from "./storage/database.js";

/**
 * The part of the bundled Intercom package's `broker/control.ts` that `atomic storage status` and
 * `atomic intercom restart` use. Intercom owns its broker protocol, socket paths and shared-state tables; the CLI
 * loads that module from the bundled package, as it loads extensions, rather than reimplementing them.
 */

export interface BrokerMultiNodeStatus {
	readonly status: "off" | "starting" | "on" | "unavailable";
	readonly reason?: string;
	readonly adapter?: string;
	readonly prefix?: string;
	readonly peers?: readonly string[];
}

export interface BrokerStatusReport {
	readonly pid: number;
	readonly sessions: number;
	readonly storage?: { readonly digest: string; readonly source: "env" | "settings" };
	readonly multiNode: BrokerMultiNodeStatus;
}

export type BrokerQuery =
	| { readonly state: "stopped" }
	| { readonly state: "running"; readonly report: BrokerStatusReport }
	| { readonly state: "legacy"; readonly pid?: number };

export interface ExpectedBrokerStorage {
	readonly digest: string;
	readonly source: "env" | "settings";
	readonly adapter: string;
	readonly prefix?: string;
}

export type RestartOutcome =
	| { readonly status: "not-running" }
	| { readonly status: "stopped"; readonly previous: { readonly pid: number; readonly sessions?: number } }
	| {
			readonly status: "restarted";
			readonly previous: { readonly pid: number; readonly sessions?: number };
			readonly current: Exclude<BrokerQuery, { state: "stopped" }>;
	  };

export interface IntercomBrokerControl {
	queryIntercomBroker(agentDir: string): Promise<BrokerQuery>;
	expectedBrokerStorage(agentDir: string, env?: NodeJS.ProcessEnv): ExpectedBrokerStorage | undefined;
	readLiveBrokers(database: SqliteExecutor, prefix: string | undefined): Promise<string[] | undefined>;
	restartIntercomBroker(
		agentDir: string,
		options?: { readonly onProgress?: (line: string) => void },
	): Promise<RestartOutcome>;
	describeMultiNodeStatus(multiNode: BrokerMultiNodeStatus): string;
}

/** Load `broker/control.ts` from the bundled Intercom package, in the npm package and the standalone binary alike. */
export async function loadIntercomBrokerControl(): Promise<IntercomBrokerControl> {
	const intercom = getBuiltinPackageLocations().find(({ distDirName }) => distDirName === "intercom");
	if (intercom === undefined) throw new Error("The bundled Intercom package was not found.");
	const modulePath = join(intercom.packageDir, "broker", "control.ts");
	const [{ createHostModuleJiti }, { getStorageAdapterHostModules }] = await Promise.all([
		import("./extensions/loader-virtual-modules.js"),
		import("./extensions/loader-host-modules.js"),
	]);
	const loader = await createHostModuleJiti(pathToFileURL(modulePath).href, await getStorageAdapterHostModules());
	return loader.import<IntercomBrokerControl>(modulePath);
}
