import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AppHostModuleSpecifier, type AppHostModules, requestAppHostModulesOnly } from "./app-host-modules.js";

export const INTERNAL_INTERCOM_BROKER_ARG = "--atomic-internal-intercom-broker";

const BROKER_HOST_MODULE_SPECIFIERS: readonly AppHostModuleSpecifier[] = ["@bastani/atomic", "@bastani/atomic/storage"];

export interface BrokerHostModulePlugin {
	name: string;
	setup(build: {
		module(specifier: string, callback: () => Promise<{ exports: object; loader: "object" }>): void;
	}): void;
}

/**
 * A Bun runtime plugin that resolves `@bastani/atomic` and `@bastani/atomic/storage` to the app bundle's own modules.
 * The bundle loads on the first such import, which only a broker with multi-node routing makes.
 */
export function createBrokerHostModulePlugin(loadApp: () => Promise<AppHostModules>): BrokerHostModulePlugin {
	let app: Promise<AppHostModules> | undefined;
	return {
		name: "atomic-broker-host-modules",
		setup(build) {
			for (const specifier of BROKER_HOST_MODULE_SPECIFIERS) {
				build.module(specifier, async () => {
					app ??= loadApp();
					return { exports: await (await app).loadHostModule(specifier), loader: "object" };
				});
			}
		},
	};
}

/** Lets the standalone binary's broker import Atomic's host modules from the app bundle at `appPath`. */
export function installBrokerHostModules(appPath: string): void {
	const bun = (globalThis as typeof globalThis & { Bun?: { plugin(plugin: BrokerHostModulePlugin): void } }).Bun;
	bun?.plugin(
		createBrokerHostModulePlugin(async () => {
			requestAppHostModulesOnly();
			const app = (await import(pathToFileURL(appPath).href)) as Partial<AppHostModules> & {
				default?: AppHostModules;
			};
			return typeof app.loadHostModule === "function" ? (app as AppHostModules) : app.default!;
		}),
	);
}

export function getBundledIntercomBrokerPath(executablePath: string = process.execPath): string {
	return join(dirname(executablePath), "builtin", "intercom", "broker", "broker.ts");
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
	const resolved = resolve(path);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isBundledIntercomBrokerPath(
	modulePath: string,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		comparablePath(modulePath, platform) === comparablePath(getBundledIntercomBrokerPath(executablePath), platform)
	);
}

export function validateInternalIntercomBrokerPath(
	modulePath: string | undefined,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!modulePath) {
		throw new Error("Atomic internal intercom broker module path is required");
	}
	if (!isBundledIntercomBrokerPath(modulePath, executablePath, platform)) {
		throw new Error("Atomic internal intercom broker path must resolve to the bundled intercom broker module");
	}
	return resolve(modulePath);
}

export async function importInternalIntercomBroker(
	modulePath: string,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const brokerPath = validateInternalIntercomBrokerPath(modulePath, executablePath, platform);
	if (!existsSync(brokerPath)) {
		throw new Error(`Atomic internal intercom broker module not found at ${brokerPath}`);
	}
	await import(pathToFileURL(brokerPath).href);
}
