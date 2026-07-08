import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const INTERNAL_INTERCOM_BROKER_ARG = "--atomic-internal-intercom-broker";

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
	return comparablePath(modulePath, platform) === comparablePath(getBundledIntercomBrokerPath(executablePath), platform);
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
