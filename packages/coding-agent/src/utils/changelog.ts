import path from "node:path";
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

// The prerelease group accepts BOTH the legacy numeric form (`-N`) and the new
// `-alpha.N` convention while capturing the numeric revision. The outer capture
// group preserves the raw version substring so each entry's `version` round-trips
// faithfully (a `0.8.1-0` header stays `0.8.1-0`; a `0.8.2-alpha.1` header stays
// `0.8.2-alpha.1`).
const RELEASE_VERSION_RE = /^(?:v)?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha\.)?(0|[1-9]\d*))?)$/;
const CHANGELOG_VERSION_HEADER_RE =
	/^##\s+\[?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha\.)?(0|[1-9]\d*))?)\]?/;
const GITHUB_REPO = "bastani-inc/atomic";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

interface ParsedVersion extends VersionParts {
	version: string;
}

function parsedVersionFromMatch(match: RegExpMatchArray): ParsedVersion {
	return {
		version: match[1] as string,
		major: Number.parseInt(match[2] as string, 10),
		minor: Number.parseInt(match[3] as string, 10),
		patch: Number.parseInt(match[4] as string, 10),
		prerelease: match[5] === undefined ? null : Number.parseInt(match[5], 10),
	};
}

function parseVersion(version: string): VersionParts | null {
	const match = version.trim().match(RELEASE_VERSION_RE);
	return match ? parsedVersionFromMatch(match) : null;
}

function parseVersionHeader(line: string): ParsedVersion | null {
	const match = line.match(CHANGELOG_VERSION_HEADER_RE);
	return match ? parsedVersionFromMatch(match) : null;
}

function createChangelogEntry(version: ParsedVersion, lines: string[]): ChangelogEntry {
	return {
		major: version.major,
		minor: version.minor,
		patch: version.patch,
		prerelease: version.prerelease,
		version: version.version,
		content: lines.join("\n").trim(),
	};
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : version.version;
	return versionString.startsWith("v") ? versionString.slice(1) : versionString;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) return true;
	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) return canonicalTarget;

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) return canonicalTarget;

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
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
		let currentVersion: ParsedVersion | null = null;

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
 * Atomic uses alpha prereleases (for example, 0.8.2-alpha.1, with the revision
 * starting at 1) while legacy numeric prerelease entries (for example, 0.8.1-0)
 * remain parseable, and started its own
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
export { getChangelogPath } from "../config.ts";
