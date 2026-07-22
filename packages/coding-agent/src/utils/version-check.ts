import { compare, valid } from "semver";
import { ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, PACKAGE_NAME, getEnvValue } from "../config.ts";

const LATEST_VERSION_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

/**
 * The versionless placeholder stamped on `main` and read from source-tree dev
 * runs (`bun packages/coding-agent/src/cli.ts`). Real releases never carry it —
 * `scripts/cut-release.ts` materializes the actual version on the tag commit —
 * so encountering it means this is a dev build that should not be compared
 * against the published registry version.
 */
const DEV_VERSION_PLACEHOLDER = "0.0.0";

export function isDevVersion(version: string): boolean {
	return version.trim() === DEV_VERSION_PLACEHOLDER;
}

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (getEnvValue(ENV_SKIP_VERSION_CHECK) || getEnvValue(ENV_OFFLINE)) return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as { name?: unknown; version?: unknown; note?: unknown };
	if (typeof data.version !== "string" || !data.version.trim()) return undefined;
	const packageName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return { version: data.version.trim(), packageName, ...(note ? { note } : {}) };
}

export async function getLatestPiVersion(
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<string | undefined> {
	// Dev builds always read the versionless `0.0.0` placeholder, which is older
	// than any published release, so the registry check would always nag. Skip it
	// (and the network call) for source-tree/dev runs.
	if (isDevVersion(currentVersion)) {
		return undefined;
	}
	try {
		const latestVersion = await getLatestPiVersion();
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
