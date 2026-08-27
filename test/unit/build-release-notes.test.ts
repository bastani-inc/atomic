import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

interface NotesResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function createPackagesDir(changelogs: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-release-notes-"));
	const packagesDir = join(root, "packages");
	for (const [name, content] of Object.entries(changelogs)) {
		mkdirSync(join(packagesDir, name), { recursive: true });
		writeFileSync(join(packagesDir, name, "CHANGELOG.md"), content);
	}
	mkdirSync(join(packagesDir, "no-changelog"), { recursive: true });
	return packagesDir;
}

function runNotes(packagesDir: string, version: string): NotesResult {
	const result = spawnSyncCollect({
		cmd: [
			bunExecutable(),
			"run",
			join(process.cwd(), "scripts", "build-release-notes.ts"),
			version,
			"--packages-dir",
			packagesDir,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("scripts/build-release-notes.ts", () => {
	test("merges sections from every package into one flat body without per-package headings", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- agent fix\n",
			subagents: "# Changelog\n\n## [1.0.0]\n\n### Added\n\n- subagent feature\n",
			workflows: "# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- workflow fix\n\n### Added\n\n- workflow feature\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			// Canonical AGENTS.md order, not the order the sections were encountered.
			assert.equal(
				result.stdout,
				"### Added\n\n- subagent feature\n- workflow feature\n\n### Fixed\n\n- agent fix\n- workflow fix\n",
			);
			assert.ok(!result.stdout.includes("## subagents"), "must not attribute entries to packages");
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("fails closed when no package documents the version", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [Unreleased]\n\n## [0.9.0]\n\n### Fixed\n\n- old fix\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr, /No packages\/\*\/CHANGELOG\.md documents version 1\.0\.0/);
			assert.equal(result.stdout, "", "a failed build must not emit partial notes");
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("fails closed when the version heading exists but carries no entries", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\n## [0.9.0]\n\n### Fixed\n\n- old fix\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 1);
			assert.doesNotMatch(result.stdout, /old fix/, "must not bleed into the next version section");
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("orders coding-agent entries first and preserves unknown section headings", () => {
		const packagesDir = createPackagesDir({
			workflows: "# Changelog\n\n## [1.0.0]\n\n### Changed\n\n- workflow change\n\n### Security\n\n- hardening\n",
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\n### Changed\n\n- agent change\n",
			intercom: "# Changelog\n\n## [1.0.0]\n\n### Changed\n\n- intercom change\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(
				result.stdout,
				"### Changed\n\n- agent change\n- intercom change\n- workflow change\n\n### Security\n\n- hardening\n",
			);
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("states a shared preamble once and keeps distinct ones", () => {
		const shared = "Cumulative release summary.";
		const packagesDir = createPackagesDir({
			"coding-agent": `# Changelog\n\n## [1.0.0]\n\n${shared}\n\n### Added\n\n- a\n`,
			subagents: `# Changelog\n\n## [1.0.0]\n\n${shared}\n\n### Added\n\n- b\n`,
			workflows: `# Changelog\n\n## [1.0.0]\n\nWorkflow-specific note.\n\n### Added\n\n- c\n`,
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout.split(shared).length - 1, 1, "identical preambles must collapse to one");
			assert.equal(result.stdout, `${shared}\n\nWorkflow-specific note.\n\n### Added\n\n- a\n- b\n- c\n`);
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("does not confuse a version with a longer version sharing its prefix", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [0.9.15]\n\n### Fixed\n\n- fifteen\n\n## [0.9.1]\n\n### Fixed\n\n- one\n",
		});
		try {
			const result = runNotes(packagesDir, "0.9.1");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout, "### Fixed\n\n- one\n");
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("preserves multi-line entries verbatim", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- first line\n  continued line\n- second entry\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout, "### Fixed\n\n- first line\n  continued line\n- second entry\n");
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});
});
