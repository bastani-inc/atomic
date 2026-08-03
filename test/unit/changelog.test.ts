import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitEnvironment } from "@bastani/atomic";
import { describe, test } from "vitest";
import {
	type ChangelogEntry,
	compareVersions,
	getEntriesForVersion,
	getNewEntries,
	parseChangelog,
} from "../../packages/coding-agent/src/utils/changelog.js";
import { moduleDir } from "../helpers/runtime.js";

function writeChangelog(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-changelog-"));
	const changelogPath = join(root, "CHANGELOG.md");
	writeFileSync(changelogPath, content);
	return changelogPath;
}

const repoRoot = join(moduleDir(import.meta.url), "..", "..");

// Sanitize the Git environment: under a hook runner (e.g. prek) Git exports
// GIT_DIR/GIT_WORK_TREE, which it honors over cwd (see git-env.ts).
function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf-8",
		env: createGitEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** The release tag for a changelog version, or null when no such tag exists locally. */
function resolveTag(version: string): string | null {
	// Atomic tags are bare (`0.9.11-alpha.9`); inherited upstream tags carry a `v` prefix.
	for (const candidate of [version, `v${version}`]) {
		try {
			git(["rev-parse", "--verify", "--quiet", `refs/tags/${candidate}^{commit}`]);
			return candidate;
		} catch {
			// try the next spelling
		}
	}
	return null;
}

function parseChangelogAtTag(tag: string, repoRelativePath: string): ChangelogEntry[] {
	const root = mkdtempSync(join(tmpdir(), "atomic-changelog-tag-"));
	try {
		const snapshotPath = join(root, "CHANGELOG.md");
		writeFileSync(snapshotPath, git(["show", `${tag}:${repoRelativePath}`]));
		return parseChangelog(snapshotPath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Compare content, not the checkout's line-ending convention. On Windows a
 * working-tree file may hold CRLF (git `core.autocrlf`), while
 * `git show <tag>:<path>` writes the blob verbatim with LF — so splitting both
 * on "\n" leaves a trailing "\r" on every working-tree line and reports every
 * released section as modified.
 */
function contentLines(entry: ChangelogEntry): string[] {
	return entry.content.split(/\r?\n/);
}

function packageChangelogPaths(): string[] {
	return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `packages/${entry.name}/CHANGELOG.md`)
		.filter((path) => parseChangelog(join(repoRoot, path)).length > 0)
		.sort();
}

describe("changelog parsing", () => {
	test("parses numeric prerelease versions as distinct changelog entries", () => {
		const changelogPath = writeChangelog(`# Changelog

## [0.8.1] - 2026-05-15

### Fixed

- Stable fix.

## [0.8.1-0] - 2026-05-15

### Fixed

- Prerelease fix.
`);

		try {
			const entries = parseChangelog(changelogPath);
			assert.deepEqual(
				entries.map((entry) => entry.version),
				["0.8.1", "0.8.1-0"],
			);
			assert.equal(entries[0]?.prerelease, null);
			assert.equal(entries[1]?.prerelease, 0);
		} finally {
			rmSync(dirname(changelogPath), { recursive: true, force: true });
		}
	});

	test("parses alpha prerelease versions, round-tripping the header and ordering by revision", () => {
		const changelogPath = writeChangelog(`# Changelog

## [0.8.24] - 2026-06-10

### Fixed

- Stable fix.

## [0.8.24-alpha.2] - 2026-06-09

### Fixed

- Second prerelease fix.

## [0.8.24-alpha.1] - 2026-06-08

### Fixed

- First prerelease fix.
`);

		try {
			const entries = parseChangelog(changelogPath);
			assert.deepEqual(
				entries.map((entry) => entry.version),
				["0.8.24", "0.8.24-alpha.2", "0.8.24-alpha.1"],
			);
			assert.equal(entries[0]?.prerelease, null);
			assert.equal(entries[1]?.prerelease, 2);
			assert.equal(entries[2]?.prerelease, 1);

			const [stable, alpha2, alpha1] = entries;
			assert.ok(stable && alpha2 && alpha1);
			// stable 0.8.24 is newer than 0.8.24-alpha.2, which is newer than 0.8.24-alpha.1.
			assert.equal(compareVersions(stable, alpha2), 1);
			assert.equal(compareVersions(alpha2, alpha1), 1);

			assert.deepEqual(
				getEntriesForVersion(entries, "0.8.24-alpha.1").map((entry) => entry.version),
				["0.8.24-alpha.1"],
			);
		} finally {
			rmSync(dirname(changelogPath), { recursive: true, force: true });
		}
	});

	test("bounds update entries to the current Atomic version", () => {
		const changelogPath = writeChangelog(`# Changelog

## [0.10.0] - 2026-05-20

- Current release.

## [0.9.0] - 2026-05-18

- Previous Atomic release.

## [0.8.1-0] - 2026-05-15

- First Atomic prerelease.

## [0.74.0] - 2026-05-07

- Historical upstream Pi release after the version reset.

## [0.10.0] - 2025-01-01

- Historical upstream Pi section with the same version number.
`);

		try {
			const entries = parseChangelog(changelogPath);
			const newEntries = getNewEntries(entries, "0.8.1-0", "0.10.0");

			assert.deepEqual(
				newEntries.map((entry) => entry.version),
				["0.10.0", "0.9.0"],
			);
			assert.deepEqual(
				getEntriesForVersion(newEntries, "0.10.0").map((entry) => entry.version),
				["0.10.0"],
			);
		} finally {
			rmSync(dirname(changelogPath), { recursive: true, force: true });
		}
	});
});

// AGENTS.md: "Each version section is immutable once released" and "New entries ALWAYS go
// under ## [Unreleased]". Once a version is tagged, its published notes are fixed, so the
// released tail of every package changelog must still read exactly as it did at that tag.
describe("released changelog sections", () => {
	const changelogPaths = packageChangelogPaths();

	test("finds a package changelog to check", () => {
		assert.ok(changelogPaths.length > 0, "no packages/*/CHANGELOG.md parsed into released sections");
	});

	for (const relativePath of changelogPaths) {
		test(`${relativePath} matches its released sections at their tag`, () => {
			const current = parseChangelog(join(repoRoot, relativePath));

			// The newest released section that was actually tagged anchors the comparison;
			// anything above it (an in-flight release, plus [Unreleased]) is still editable.
			let anchor: { entry: ChangelogEntry; tag: string } | null = null;
			for (const entry of current) {
				const tag = resolveTag(entry.version);
				if (tag) {
					anchor = { entry, tag };
					break;
				}
			}
			assert.ok(
				anchor,
				`no version in ${relativePath} resolves to a local tag; fetch tags before running this suite`,
			);

			const tagged = parseChangelogAtTag(anchor.tag, relativePath);
			const taggedIndex = tagged.findIndex((entry) => entry.version === anchor.entry.version);
			assert.notEqual(
				taggedIndex,
				-1,
				`${relativePath} at tag ${anchor.tag} has no [${anchor.entry.version}] section`,
			);

			const currentTail = current.slice(current.indexOf(anchor.entry));
			const taggedTail = tagged.slice(taggedIndex);
			assert.deepEqual(
				currentTail.map((entry) => entry.version),
				taggedTail.map((entry) => entry.version),
				`${relativePath}: the released section list changed since tag ${anchor.tag}`,
			);

			for (const [offset, taggedEntry] of taggedTail.entries()) {
				const currentEntry = currentTail[offset] as ChangelogEntry;
				assert.deepEqual(
					contentLines(currentEntry),
					contentLines(taggedEntry),
					`${relativePath}: released section [${taggedEntry.version}] differs from its content at tag ${anchor.tag}. Released sections are immutable — new entries belong under ## [Unreleased].`,
				);
			}
		});
	}
});
