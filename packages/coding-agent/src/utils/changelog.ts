import { existsSync, readFileSync } from "fs";

export interface VersionParts {
	major: number;
	minor: number;
	patch: number;
	prerelease: number | null;
}

export interface ChangelogEntry extends VersionParts {
	version: string;
	content: string;
}

const RELEASE_VERSION_RE = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;
const CHANGELOG_VERSION_HEADER_RE = /^##\s+\[?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?\]?/;

function formatVersion(parts: VersionParts): string {
	const base = `${parts.major}.${parts.minor}.${parts.patch}`;
	return parts.prerelease === null ? base : `${base}-${parts.prerelease}`;
}

function partsFromMatch(match: RegExpMatchArray): VersionParts {
	return {
		major: Number.parseInt(match[1] as string, 10),
		minor: Number.parseInt(match[2] as string, 10),
		patch: Number.parseInt(match[3] as string, 10),
		prerelease: match[4] === undefined ? null : Number.parseInt(match[4], 10),
	};
}

function parseVersion(version: string): VersionParts | null {
	const match = version.trim().match(RELEASE_VERSION_RE);
	return match ? partsFromMatch(match) : null;
}

function parseVersionHeader(line: string): VersionParts | null {
	const match = line.match(CHANGELOG_VERSION_HEADER_RE);
	return match ? partsFromMatch(match) : null;
}

function createChangelogEntry(version: VersionParts, lines: string[]): ChangelogEntry {
	return {
		...version,
		version: formatVersion(version),
		content: lines.join("\n").trim(),
	};
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: VersionParts | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push(createChangelogEntry(currentVersion, currentLines));
				}

				// Try to parse version from this line
				const versionParts = parseVersionHeader(line);
				if (versionParts) {
					currentVersion = versionParts;
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push(createChangelogEntry(currentVersion, currentLines));
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: VersionParts, v2: VersionParts): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	if (v1.patch !== v2.patch) return v1.patch - v2.patch;
	if (v1.prerelease === v2.prerelease) return 0;
	if (v1.prerelease === null) return 1;
	if (v2.prerelease === null) return -1;
	return v1.prerelease - v2.prerelease;
}

/**
 * Get entries newer than lastVersion, optionally bounded by currentVersion.
 *
 * Atomic uses numeric prereleases (for example, 0.8.1-0) and started its own
 * version line above the upstream Pi changelog history. When currentVersion is
 * provided, changelog order wins over semantic version filtering so historical
 * upstream entries like 0.74.0 or an old 0.10.0 section are not treated as
 * newer Atomic releases.
 */
function findVersionIndex(entries: ChangelogEntry[], version: string): number {
	const target = parseVersion(version);
	if (!target) return -1;
	return entries.findIndex((entry) => compareVersions(entry, target) === 0);
}

export function getNewEntries(
	entries: ChangelogEntry[],
	lastVersion: string,
	currentVersion?: string,
): ChangelogEntry[] {
	if (currentVersion) {
		const currentIndex = findVersionIndex(entries, currentVersion);
		if (currentIndex === -1) return [];

		const lastIndex = findVersionIndex(entries, lastVersion);
		if (lastIndex !== -1) {
			return currentIndex < lastIndex ? entries.slice(currentIndex, lastIndex) : [];
		}

		const currentEntry = entries[currentIndex];
		return currentIndex === 0 && currentEntry ? [currentEntry] : [];
	}

	const last = parseVersion(lastVersion) ?? { major: 0, minor: 0, patch: 0, prerelease: null };
	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

export function getEntriesForVersion(entries: ChangelogEntry[], version: string): ChangelogEntry[] {
	const target = parseVersion(version);
	if (!target) return [];
	return entries.filter((entry) => compareVersions(entry, target) === 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.js";
