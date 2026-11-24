import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import {
	buildReleaseNotes,
	type ChangelogSource,
	extractVersionSection,
	readChangelogSources,
} from "../../scripts/build-release-notes.js";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

interface NotesResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const FULL_CHANGELOG_OPEN = "<details>\n<summary>Full changelog</summary>\n\n";
const FULL_CHANGELOG_CLOSE = "\n</details>\n";

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

	test("states a shared summary once, keeps distinct ones, and folds the full changelog away (#3804)", () => {
		const shared = "Cumulative release summary.";
		const packagesDir = createPackagesDir({
			"coding-agent": `# Changelog\n\n## [1.0.0]\n\n${shared}\n\n### Added\n\n- a\n`,
			subagents: `# Changelog\n\n## [1.0.0]\n\n${shared}\n\n### Added\n\n- b\n`,
			workflows: `# Changelog\n\n## [1.0.0]\n\nWorkflow-specific note.\n\n### Added\n\n- c\n`,
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout.split(shared).length - 1, 1, "identical summaries must collapse to one");
			assert.equal(
				result.stdout,
				`${shared}\n\nWorkflow-specific note.\n\n${FULL_CHANGELOG_OPEN}### Added\n\n- a\n- b\n- c\n${FULL_CHANGELOG_CLOSE}`,
			);
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("leads with the human summary and wraps the merged sections in a collapsible full changelog (#3804)", () => {
		const packagesDir = createPackagesDir({
			"coding-agent":
				"# Changelog\n\n## [1.0.0]\n\nFaster, calmer sessions.\n\n- **Quicker start:** boots sooner.\n\n### Fixed\n\n- agent fix\n",
			subagents: "# Changelog\n\n## [1.0.0]\n\n### Added\n\n- subagent feature\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(
				result.stdout,
				"Faster, calmer sessions.\n\n- **Quicker start:** boots sooner.\n\n" +
					"<details>\n<summary>Full changelog</summary>\n\n" +
					"### Added\n\n- subagent feature\n\n### Fixed\n\n- agent fix\n" +
					"\n</details>\n",
			);
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("emits only the summary when the version has no detailed sections (#3804)", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\nJust the summary.\n\n## [0.9.0]\n\n### Fixed\n\n- old fix\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout, "Just the summary.\n");
			assert.doesNotMatch(result.stdout, /<details>/);
		} finally {
			rmSync(join(packagesDir, ".."), { recursive: true, force: true });
		}
	});

	test("keeps the flat output when no package carries a summary (#3804)", () => {
		const packagesDir = createPackagesDir({
			"coding-agent": "# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- agent fix\n",
			workflows: "# Changelog\n\n## [1.0.0]\n\n### Added\n\n- workflow feature\n",
		});
		try {
			const result = runNotes(packagesDir, "1.0.0");
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(result.stdout, "### Added\n\n- workflow feature\n\n### Fixed\n\n- agent fix\n");
			assert.doesNotMatch(result.stdout, /<details>/);
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

const repoRoot = join(moduleDir(import.meta.url), "..", "..");
// `packages/coding-agent/CHANGELOG.md` at a tag is larger than execFileSync's 1 MiB default.
const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function git(args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf-8",
		env: createGitEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
	});
}

/** Every package changelog exactly as it was published at `tag`. */
function changelogSourcesAtTag(tag: string): ChangelogSource[] {
	const paths = git(["ls-tree", "--name-only", `${tag}:packages`])
		.split("\n")
		.filter(Boolean);
	const sources: ChangelogSource[] = [];
	for (const name of paths) {
		const listing = git(["ls-tree", "--name-only", tag, `packages/${name}/CHANGELOG.md`]).trim();
		if (listing === "") continue;
		sources.push({ name, content: git(["show", `${tag}:packages/${name}/CHANGELOG.md`]) });
	}
	return sources;
}

/** The summary that leads the notes: everything before the collapsed full changelog. */
function summaryOf(notes: string): string {
	const index = notes.indexOf("<details>");
	return index < 0 ? notes : notes.slice(0, index);
}

function bulletsOf(markdown: string): string[] {
	return markdown.split("\n").filter((line) => line.startsWith("- "));
}

function issueLink(kind: "issues" | "pull", number: number): string {
	return `[#${number}](https://github.com/bastani-inc/atomic/${kind}/${number})`;
}

describe("release-note deduplication (#4799)", () => {
	test("rebuilds the 0.9.86 summary with each change listed once (#4799)", () => {
		const notes = buildReleaseNotes(changelogSourcesAtTag("0.9.86"), "0.9.86");
		const summaryBullets = bulletsOf(summaryOf(notes));

		// Published with 11 bullets: non-blocking asks x3, degraded restores x2,
		// subagent-chat autocomplete x2 (plus the stage-chat `@` bullet citing the
		// same issue and PR), send-to-many x2, and credential stripping.
		assert.equal(summaryBullets.length, 5, summaryBullets.join("\n"));
		for (const [label, link] of [
			["non-blocking asks", issueLink("issues", 4751)],
			["degraded restores", issueLink("issues", 4738)],
			["subagent-chat autocomplete", issueLink("issues", 4755)],
			["send to many", issueLink("issues", 4752)],
			["credential stripping", issueLink("pull", 4749)],
		] as const) {
			const citing = summaryBullets.filter((bullet) => bullet.includes(link));
			assert.equal(citing.length, 1, `${label} must appear once in the summary:\n${citing.join("\n")}`);
		}
		// The most complete copy wins: intercom's bullet is the only one that cites #4760.
		const asks = summaryBullets.find((bullet) => bullet.includes(issueLink("issues", 4751)));
		assert.ok(asks?.startsWith("- **Non-blocking asks.**"), asks);
		assert.ok(asks?.includes(issueLink("issues", 4760)));
		// Not deduplicated across the summary and the full changelog.
		assert.match(notes.slice(notes.indexOf("<details>")), /\[#4751\]/);
	});

	test("leaves the single-summary 0.9.87 notes unchanged (#4799)", () => {
		const notes = buildReleaseNotes(changelogSourcesAtTag("0.9.87"), "0.9.87");
		assert.equal(bulletsOf(summaryOf(notes)).length, 1);
		assert.equal(bulletsOf(notes).length, 2);
	});

	test("merges a bullet whose links are a subset of another's into the most complete one (#4799)", () => {
		const broad = `- **Broad.** Short ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2), [#3](https://github.com/o/r/issues/3)).`;
		const narrow = `- **Narrow but wordier than the broad bullet is.** Long text ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2)).`;
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: `## [1.0.0]\n\nTheme.\n\n${narrow}\n\n### Fixed\n\n- fix\n` },
				{ name: "intercom", content: `## [1.0.0]\n\nOther theme.\n\n${broad}\n` },
			],
			"1.0.0",
		);
		// The broad bullet replaces the narrow one in place, and the package summary
		// left without bullets is dropped rather than shown as an orphaned theme line.
		assert.equal(
			notes,
			`Theme.\n\n${broad}\n\n<details>\n<summary>Full changelog</summary>\n\n### Fixed\n\n- fix\n\n</details>\n`,
		);
	});

	test("keeps the longer bullet when two cite the same links, inside a ### section (#4799)", () => {
		const short = "- Fixed a thing ([#7](https://github.com/o/r/issues/7), [#8](https://github.com/o/r/pull/8))";
		const long =
			"- Fixed a thing, with more detail ([#7](https://github.com/o/r/issues/7), [#8](https://github.com/o/r/pull/8))";
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: `## [1.0.0]\n\n### Fixed\n\n${short}\n- other fix\n` },
				{ name: "subagents", content: `## [1.0.0]\n\n### Fixed\n\n${long}\n` },
			],
			"1.0.0",
		);
		assert.equal(notes, `### Fixed\n\n${long}\n- other fix\n`);
	});

	test("does not merge distinct bullets that share only some links or a single link (#4799)", () => {
		const partialA = "- A ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2))";
		const partialB = "- B ([#1](https://github.com/o/r/issues/1), [#3](https://github.com/o/r/pull/3))";
		const singleA = "- Workflow stage chats complete `@` paths ([#9](https://github.com/o/r/issues/9))";
		const singleB = "- Subagent chats complete `/tasks` ([#9](https://github.com/o/r/issues/9))";
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: `## [1.0.0]\n\n### Fixed\n\n${partialA}\n${singleA}\n` },
				{ name: "workflows", content: `## [1.0.0]\n\n### Fixed\n\n${partialB}\n${singleB}\n` },
			],
			"1.0.0",
		);
		assert.equal(notes, `### Fixed\n\n${partialA}\n${singleA}\n${partialB}\n${singleB}\n`);
	});

	test("joins changes that a later, broader bullet connects (#4799)", () => {
		const oneTwo = "- One-two ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2))";
		const oneThree = "- One-three ([#1](https://github.com/o/r/issues/1), [#3](https://github.com/o/r/pull/3))";
		const all =
			"- All three ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2), [#3](https://github.com/o/r/pull/3))";
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: `## [1.0.0]\n\n### Changed\n\n${oneTwo}\n` },
				{ name: "intercom", content: `## [1.0.0]\n\n### Changed\n\n${oneThree}\n` },
				{ name: "subagents", content: `## [1.0.0]\n\n### Changed\n\n${all}\n` },
			],
			"1.0.0",
		);
		assert.equal(notes, `### Changed\n\n${all}\n`);
	});

	test("keeps a package summary's breaking-change note when its bullets repeat earlier ones (#4799)", () => {
		const bullet = "- **Same.** Text ([#1](https://github.com/o/r/issues/1), [#2](https://github.com/o/r/pull/2)).";
		const warning = "**Breaking change:** rename `foo` to `bar`.";
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: `## [1.0.0]\n\nTheme.\n\n${bullet}\n` },
				{ name: "workflows", content: `## [1.0.0]\n\nOther theme.\n\n${bullet}\n\n${warning}\n` },
			],
			"1.0.0",
		);
		assert.equal(notes, `Theme.\n\n${bullet}\n\n${warning}\n`);
	});

	test("drops a verbatim repeat of a bullet with no links (#4799)", () => {
		const notes = buildReleaseNotes(
			[
				{ name: "coding-agent", content: "## [1.0.0]\n\n### Added\n\n- same entry\n" },
				{ name: "workflows", content: "## [1.0.0]\n\n### Added\n\n- same  entry\n- distinct entry\n" },
			],
			"1.0.0",
		);
		assert.equal(notes, "### Added\n\n- same entry\n- distinct entry\n");
	});
});

function oLink(number: number): string {
	return `[#${number}](https://github.com/o/r/issues/${number})`;
}

function bulletWithLinks(text: string, links: readonly number[]): string {
	return `- ${text} (${links.map(oLink).join(", ")})`;
}

function linksOf(bullet: string): Set<number> {
	return new Set([...bullet.matchAll(/\/issues\/(\d+)\)/g)].map((match) => Number(match[1])));
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

/** Deterministic PRNG (mulberry32) so a failing property run is reproducible from its seed. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const PACKAGE_NAMES = ["coding-agent", "intercom", "subagents", "workflows"] as const;

function fixedSources(entries: readonly (readonly string[])[]): ChangelogSource[] {
	return entries.map((bullets, index) => ({
		name: PACKAGE_NAMES[index],
		content: `## [1.0.0]\n\n### Fixed\n\n${bullets.join("\n")}\n`,
	}));
}

describe("release-note deduplication keeps every distinct change (#4835)", () => {
	const resume = bulletWithLinks("Fixed session resume", [1, 2]);
	const subagents = bulletWithLinks("Fixed session resume for subagents", [1, 2, 3]);
	const lease = bulletWithLinks("Fixed workflow lease timeout", [1, 2, 4]);

	for (const order of permutations([resume, subagents, lease])) {
		test(`keeps both bullets that a shared subset bullet overlaps, input order ${order.map((bullet) => [resume, subagents, lease].indexOf(bullet)).join("")} (#4835)`, () => {
			const notes = buildReleaseNotes(fixedSources(order.map((bullet) => [bullet])), "1.0.0");
			const expected = order.filter((bullet) => bullet !== resume);
			assert.equal(notes, `### Fixed\n\n${expected.join("\n")}\n`);
		});
	}

	test("never drops a distinct change, is idempotent, and keeps the same bullets in any input order (#4835)", () => {
		const SEEDS = 200;
		const words = ["alpha", "beta", "gamma", "delta"];
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const random = seededRandom(seed);
			const pick = (count: number): number => Math.floor(random() * count);
			const pool: string[] = [];
			const packages: string[][] = PACKAGE_NAMES.map(() => []);
			const bulletCount = 2 + pick(8);
			for (let index = 0; index < bulletCount; index += 1) {
				let bullet: string;
				if (pool.length > 0 && random() < 0.2) {
					bullet = pool[pick(pool.length)];
				} else {
					const links = [1, 2, 3, 4, 5].filter(() => random() < 0.45);
					const text = `Fixed ${words[pick(words.length)]} ${index}`;
					bullet = links.length > 0 ? bulletWithLinks(text, links) : `- ${text}`;
					pool.push(bullet);
				}
				packages[pick(packages.length)].push(bullet);
			}
			const context = `seed ${seed}:\n${packages.map((bullets) => bullets.join("\n")).join("\n--\n")}`;

			const notes = buildReleaseNotes(fixedSources(packages), "1.0.0");
			const kept = bulletsOf(notes);
			const keptLinks = kept.map(linksOf);
			for (const bullet of packages.flat()) {
				if (kept.includes(bullet)) continue;
				const links = linksOf(bullet);
				const covered = keptLinks.some((set) => links.size >= 2 && [...links].every((link) => set.has(link)));
				assert.ok(covered, `${bullet} was dropped without a kept bullet covering it\n${context}\n=>\n${notes}`);
			}

			const rebuilt = buildReleaseNotes([{ name: "coding-agent", content: `## [1.0.0]\n\n${notes}` }], "1.0.0");
			assert.equal(rebuilt, notes, `not idempotent\n${context}`);

			const reversed = buildReleaseNotes(fixedSources([...packages].reverse()), "1.0.0");
			assert.deepEqual(new Set(bulletsOf(reversed)), new Set(kept), `order-dependent\n${context}`);
		}
	});

	test("ignores pre-monorepo historical sections that collide with a newer release version", () => {
		const webAccessChangelog = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [0.10.5] - 2026-11-23",
			"",
			"### Fixed",
			"",
			"- Recent unified monorepo fix.",
			"",
			"## [0.8.15] - 2026-05-26",
			"",
			"### Changed",
			"",
			"- Promoted 0.8.15.",
			"",
			"## [0.10.7] - 2026-05-02",
			"",
			"### Fixed",
			"",
			"- Stale pre-monorepo Exa code_search fallback.",
			"",
		].join("\n");

		assert.equal(extractVersionSection(webAccessChangelog, "0.10.7"), null);
		assert.equal(extractVersionSection(webAccessChangelog, "0.10.4"), null);
		assert.ok(extractVersionSection(webAccessChangelog, "0.10.5"));

		const withNew0107 = webAccessChangelog.replace(
			"## [Unreleased]\n",
			"## [Unreleased]\n\n## [0.10.7] - 2026-11-24\n\n### Fixed\n\n- Real unified 0.10.7 fix.\n",
		);
		const matched = extractVersionSection(withNew0107, "0.10.7");
		assert.equal(matched?.sections.get("Fixed"), "- Real unified 0.10.7 fix.");

		const repoNotes = buildReleaseNotes(readChangelogSources(join(process.cwd(), "packages")), "0.10.7");
		assert.ok(!repoNotes.includes("get_code_context_exa"), "must not include stale May 2026 web-access notes");
		assert.ok(!repoNotes.includes("summaryModel"), "must not include stale May 2026 web-access notes");
	});
});
