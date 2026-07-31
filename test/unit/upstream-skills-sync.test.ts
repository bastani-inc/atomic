/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, test } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { clearSkillCache, resolveSkills } from "../../packages/subagents/src/agents/skills.js";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const subagentSkills = join(root, "packages/subagents/skills");
const workflowSkills = join(root, "packages/workflows/skills");
const liteparseSkill = join(subagentSkills, "liteparse");

// run-llama/llamaparse-agent-skills `main` at 2dcef7c62417bd2ec4671fce4621bb1e8cce48d0
// ships exactly these two files under `skills/liteparse/`, both tracked as 100644.
const liteparseTree: ReadonlyArray<readonly [path: string, sha256: string]> = [
	["SKILL.md", "b29e84f059c9b8848feaf8963f8212d8ce4d8d4a54b0ce2be55561b4f8b5cb02"],
	["scripts/search.py", "72d960a0600ebcef1252c558159c5fa6b9e7ee23baad36a07ca878dd42cc9bfd"],
];
// Reversing Atomic's two documented adaptations must reproduce the canonical upstream
// SKILL.md byte-for-byte, which proves no undocumented local drift exists.
const liteparseAdaptations: ReadonlyArray<readonly [atomic: string, canonical: string]> = [
	["# LiteParse\n", "# Effective LiteParse\n"],
	["\nscripts/search.py /tmp/doc.txt", "\n./.claude/skills/effective-liteparse/scripts/search.py /tmp/doc.txt"],
];
const liteparseCanonicalSkillSha256 = "c4982f937fe569cd109801e9c6f0bd80219df93835d9a206bae6958c5e3c841c";

function sha256(contents: string | Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

function canonicalText(contents: string | Buffer): string {
	const text = typeof contents === "string" ? contents : contents.toString("utf8");
	return text.replace(/\r\n/gu, "\n");
}

function assertLiteParseContent(path: string, expected: string, displayPath: string): void {
	assert.equal(sha256(canonicalText(readFileSync(path))), expected, `LiteParse content drift: ${displayPath}`);
}

function runFixtureGit(cwd: string, args: readonly string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

// Git hooks export repository-local variables that override cwd and can redirect
// fixture commands into the invoking linked worktree unless they are removed.
function initializeFixtureRepository(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	const result = spawnSyncCollect(["git", "init", "--quiet"], { cwd, env: createGitEnvironment(undefined, env) });
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

function assertRegularTree(path: string): void {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		assert.equal(lstatSync(child).isSymbolicLink(), false, `unexpected symlink: ${child}`);
		if (entry.isDirectory()) assertRegularTree(child);
	}
}

function collectFiles(path: string, into: string[] = [], base: string = root): string[] {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) collectFiles(child, into, base);
		else into.push(relative(base, child).replace(/\\/g, "/"));
	}
	return into;
}

function assertNoScaffolding(base: string): void {
	for (const path of ["LICENSE", "UPSTREAM.md", "UPSTREAM_FILES.json"]) {
		assert.equal(existsSync(join(base, path)), false, `unexpected Atomic scaffolding: ${path}`);
	}
}

function packedPaths(packageDir: string): string[] {
	const result = spawnSyncCollect(["bun", "pm", "pack", "--dry-run"], { cwd: packageDir });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.split("\n")
		.flatMap((line) => {
			const match = /^packed\s+\S+\s+(.+)$/u.exec(line.trim());
			return match ? [match[1]] : [];
		});
}

function assertPacked(packageDir: string, skillPaths: readonly string[]): void {
	const packed = packedPaths(packageDir);
	for (const path of skillPaths) assert.ok(packed.includes(path), `packed archive omitted ${path}`);
}

function assertFiles(base: string, paths: readonly string[]): void {
	for (const path of paths) assert.ok(existsSync(join(base, path)), `missing bundled resource: ${path}`);
}

/**
 * Structural: the test below performs a full builtin-package loader reload,
 * which discovers, transforms and imports every bundled package resource before
 * a single assertion runs. That cost is the work under test, not a slow test
 * nobody fixed, and on a loaded Windows runner it used 87 % of the shared
 * per-test budget. Named and kept at the call site, per the per-test timeout
 * policy in AGENTS.md.
 */
const BUILTIN_LOADER_RELOAD_TIMEOUT_MS = 120_000;

describe("synced upstream skill trees", () => {
	test("discovers the renamed subagent skills and removes the old name", () => {
		clearSkillCache();
		const result = resolveSkills(["playwright-cli", "liteparse", "effective-liteparse"], root);
		assert.deepEqual(result.resolved.map((skill) => skill.name).sort(), ["liteparse", "playwright-cli"]);
		assert.deepEqual(result.missing, ["effective-liteparse"]);
		assert.match(readFileSync(join(subagentSkills, "liteparse/SKILL.md"), "utf8"), /^---\r?\nname: liteparse\r?$/m);
		assert.equal(existsSync(join(subagentSkills, "effective-liteparse")), false);
	});

	test(
		"discovers Impeccable through the coding-agent package loader",
		async () => {
			const agentDir = mkdtempSync(join(tmpdir(), "atomic-impeccable-discovery-"));
			try {
				const loader = new DefaultResourceLoader({
					cwd: root,
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					builtinPackagePaths: [join(root, "packages/workflows")],
				});
				await loader.reload();
				assert.ok(loader.getSkills().skills.some((skill) => skill.name === "impeccable"));
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		BUILTIN_LOADER_RELOAD_TIMEOUT_MS,
	);

	test("bundles meaningful upstream skill content without Atomic scaffolding", () => {
		assertFiles(join(subagentSkills, "playwright-cli"), [
			"SKILL.md",
			"references/element-attributes.md",
			"references/playwright-tests.md",
			"references/request-mocking.md",
			"references/running-code.md",
			"references/session-management.md",
			"references/storage-state.md",
			"references/test-generation.md",
			"references/tracing.md",
			"references/video-recording.md",
		]);
		assertFiles(join(subagentSkills, "liteparse"), ["SKILL.md", "scripts/search.py"]);
		assertFiles(join(workflowSkills, "impeccable"), [
			"SKILL.md",
			"agents/openai.yaml",
			"agents/impeccable_documenter.toml",
			"agents/impeccable_finish_reviewer.toml",
			"reference/live.md",
			"reference/hooks.md",
			"reference/craft-floor.md",
			"reference/doctor.md",
			"reference/new-work.md",
			"reference/operate.md",
			"reference/routing.md",
			"reference/visualize.md",
			"reference/degraded/asset-producer.md",
			"reference/degraded/documenter.md",
			"reference/degraded/finish-reviewer.md",
			"reference/degraded/manual-edit-applier.md",
			"scripts/command-metadata.json",
			"scripts/lib/provider.mjs",
			"scripts/detector/cli/main.mjs",
			"scripts/doctor.mjs",
			"scripts/concept-seed.mjs",
			"scripts/generate-image.mjs",
			"scripts/surface-brief.mjs",
			"scripts/lib/staleness.mjs",
			"scripts/lib/staleness-deep.mjs",
			"scripts/lib/surface-briefs.mjs",
			"scripts/live/generation-preflight.mjs",
			"scripts/live/poll-lanes.mjs",
			"scripts/live/tanstack-adapter.mjs",
			"scripts/live/browser-script-parts.mjs",
			"scripts/modern-screenshot.umd.js",
		]);
		assert.match(readFileSync(join(workflowSkills, "impeccable/SKILL.md"), "utf8"), /^version: 4\.0\.3\r?$/m);
		for (const stale of [
			"reference/brand.md",
			"reference/codex.md",
			"reference/interaction-design.md",
			"reference/product.md",
		]) {
			assert.equal(existsSync(join(workflowSkills, "impeccable", stale)), false, `stale upstream file: ${stale}`);
		}
		assertNoScaffolding(join(subagentSkills, "playwright-cli"));
		assertNoScaffolding(join(subagentSkills, "liteparse"));
		assertNoScaffolding(join(workflowSkills, "impeccable"));
		assertPacked(join(root, "packages/subagents"), [
			"skills/playwright-cli/references/test-generation.md",
			"skills/liteparse/scripts/search.py",
		]);
		assertPacked(join(root, "packages/workflows"), [
			"skills/impeccable/scripts/live/svelte-component.mjs",
			"skills/impeccable/scripts/lib/provider.mjs",
		]);
	});

	test("ships the exact canonical LiteParse tree with no undocumented drift", () => {
		assert.deepEqual(
			collectFiles(liteparseSkill, [], liteparseSkill).sort(),
			liteparseTree.map(([path]) => path),
		);
		for (const [path, expected] of liteparseTree) {
			assertLiteParseContent(join(liteparseSkill, path), expected, path);
		}
		// Reversing both documented adaptations must reproduce upstream's SKILL.md exactly.
		let canonical = canonicalText(readFileSync(join(liteparseSkill, "SKILL.md")));
		for (const [atomic, upstream] of liteparseAdaptations) {
			assert.ok(canonical.includes(atomic), `lost documented Atomic adaptation: ${JSON.stringify(atomic)}`);
			canonical = canonical.replace(atomic, upstream);
		}
		assert.equal(
			sha256(canonical),
			liteparseCanonicalSkillSha256,
			"LiteParse diverges from upstream beyond its two documented adaptations",
		);
		assert.doesNotMatch(readFileSync(join(liteparseSkill, "SKILL.md"), "utf8"), /effective-liteparse/u);
	});

	test("validates LiteParse content across LF and CRLF checkouts without hiding real drift", () => {
		const fixture = mkdtempSync(join(tmpdir(), "atomic-liteparse-line-endings-"));
		const expected = liteparseTree[0][1];
		const canonicalContents = readFileSync(join(liteparseSkill, "SKILL.md"), "utf8").replace(/\r\n/gu, "\n");
		const lf = join(fixture, "lf-SKILL.md");
		const crlf = join(fixture, "crlf-SKILL.md");
		const changed = join(fixture, "changed-SKILL.md");
		try {
			writeFileSync(lf, canonicalContents);
			writeFileSync(crlf, canonicalContents.replace(/\n/gu, "\r\n"));
			writeFileSync(
				changed,
				canonicalContents.replace("# LiteParse", "# Changed LiteParse").replace(/\n/gu, "\r\n"),
			);

			assertLiteParseContent(lf, expected, "SKILL.md");
			assertLiteParseContent(crlf, expected, "SKILL.md");
			assert.throws(
				() => assertLiteParseContent(changed, expected, "SKILL.md"),
				/LiteParse content drift: SKILL\.md/u,
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	test("tracks the LiteParse tree as non-executable and packs exactly its two files", () => {
		const staged = spawnSyncCollect(["git", "ls-files", "--stage", "--", "packages/subagents/skills/liteparse"], {
			cwd: root,
			env: createGitEnvironment(),
		});
		assert.equal(staged.exitCode, 0, staged.stderr.toString());
		const trackedModes = staged.stdout
			.toString()
			.trim()
			.split("\n")
			.map((line) => {
				const [metadata, path] = line.split("\t");
				return `${metadata.split(" ")[0]} ${path}`;
			});
		assert.deepEqual(
			trackedModes,
			liteparseTree.map(([path]) => `100644 packages/subagents/skills/liteparse/${path}`),
		);
		const packed = packedPaths(join(root, "packages/subagents"));
		assert.deepEqual(
			packed.filter((path) => path.includes("liteparse")),
			liteparseTree.map(([path]) => `skills/liteparse/${path}`),
		);
	});

	test("contains no accidental symlinks", () => {
		assertRegularTree(join(subagentSkills, "playwright-cli"));
		assertRegularTree(join(subagentSkills, "liteparse"));
		assertRegularTree(join(workflowSkills, "impeccable"));
	});

	test("tracks every bundled skill file instead of silently ignoring part of a synced tree", () => {
		const skillFiles = [...collectFiles(subagentSkills), ...collectFiles(workflowSkills)];
		assert.ok(skillFiles.length > 100, `expected a complete bundled skill inventory, saw ${skillFiles.length}`);
		// `--no-index` reports ignore rules even for already-tracked paths, so a broad
		// rule (such as the Python packaging `lib/`) cannot silently truncate a sync.
		const ignored = spawnSyncCollect(["git", "check-ignore", "--no-index", "--stdin"], {
			cwd: root,
			env: createGitEnvironment(),
			stdin: Buffer.from(`${skillFiles.join("\n")}\n`),
		});
		assert.equal(ignored.stdout.toString().trim(), "", "bundled skill files are excluded by .gitignore");
		const tracked = spawnSyncCollect(["git", "ls-files", "packages/workflows/skills/impeccable"], {
			cwd: root,
			env: createGitEnvironment(),
		});
		assert.equal(tracked.exitCode, 0, tracked.stderr.toString());
		for (const path of ["scripts/lib/staleness.mjs", "scripts/lib/surface-briefs.mjs", "scripts/lib/provider.mjs"]) {
			assert.ok(
				tracked.stdout.toString().includes(`packages/workflows/skills/impeccable/${path}\n`),
				`untracked bundled file: ${path}`,
			);
		}
	});

	test("keeps synced HTML filtering robust against nested sanitization and permissive closing tags", async () => {
		const svelteModulePath = join(workflowSkills, "impeccable/scripts/live/svelte-component.mjs");
		const svelteModule = (await import(svelteModulePath)) as {
			parseSvelteComponentFile(content: string): { markup: string };
			svelteMarkupHasVisibleContent(markup: string): boolean;
		};
		assert.equal(svelteModule.svelteMarkupHasVisibleContent("<scri<script>x</script>pt>hidden</script>"), false);
		assert.equal(svelteModule.svelteMarkupHasVisibleContent("<!<!--- hidden --->>"), false);
		assert.equal(
			svelteModule.parseSvelteComponentFile("<script>const x = 1;</script \t\n data-x>\n<main>visible</main>")
				.markup,
			"<main>visible</main>",
		);

		const pageModulePath = join(workflowSkills, "impeccable/scripts/detector/shared/page.mjs");
		const pageModule = (await import(pageModulePath)) as { isFullPage(content: string): boolean };
		assert.equal(pageModule.isFullPage("<!<!--- hidden --->><section>partial</section>"), false);
		// Upstream's regex comment strip misses the permissive `--!>` ending and reports this as a full page.
		assert.equal(pageModule.isFullPage("<!--<html>--!>"), false);
	});
	test("keeps Impeccable visual-evidence detection blind to commented-out markup", async () => {
		const contextModule = (await import(join(workflowSkills, "impeccable/scripts/context.mjs"))) as {
			hasVisualImplementation(projectRoot: string): boolean;
		};
		const filler = "<p>Plain authored copy with no styling evidence at all.</p>\n".repeat(16);
		const hiddenStyle = "<style>.a{color:red}</style>";
		const fixtures: ReadonlyArray<readonly [name: string, markup: string, expected: boolean]> = [
			["nested-opener", `${filler}<!<!-- inner -->-- ${hiddenStyle} -->`, false],
			["permissive-closer", `${filler}<!-- ${hiddenStyle} --!>`, false],
			["visible-style", `${filler}${hiddenStyle}`, true],
		];
		for (const [name, markup, expected] of fixtures) {
			const projectRoot = mkdtempSync(join(tmpdir(), `atomic-impeccable-visual-${name}-`));
			try {
				assert.ok(markup.length > 600, `fixture ${name} is under the HTML evidence threshold`);
				writeFileSync(join(projectRoot, "index.html"), markup);
				assert.equal(contextModule.hasVisualImplementation(projectRoot), expected, `visual evidence: ${name}`);
			} finally {
				rmSync(projectRoot, { recursive: true, force: true });
			}
		}
	});

	test("keeps synced live-preview selector and CSS-property hardening", () => {
		const browser = readFileSync(join(workflowSkills, "impeccable/scripts/live-browser.js"), "utf8");
		// A backslash-bearing session ID must be escaped before it reaches the attribute selector.
		assert.ok(
			browser.includes("String(sessionId).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"')"),
			"preview selector lost its backslash escaping",
		);
		// The ineffective `-ms-` self-replacement stays removed (CodeQL useless-assignment fix).
		assert.doesNotMatch(browser, /replace\(\/\^-ms-\/, '-ms-'\)/u);
	});

	test("initializes its fixture without mutating an ambient linked worktree", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "atomic-impeccable-git-env-"));
		const primary = join(fixtureRoot, "primary");
		const linked = join(fixtureRoot, "linked");
		const target = join(fixtureRoot, "target");
		mkdirSync(primary);
		mkdirSync(target);
		try {
			runFixtureGit(primary, ["init", "--initial-branch=main", "--quiet"]);
			writeFileSync(join(primary, "tracked.txt"), "primary\n");
			runFixtureGit(primary, ["add", "tracked.txt"]);
			runFixtureGit(primary, [
				"-c",
				"user.name=Atomic Test",
				"-c",
				"user.email=atomic-test@example.com",
				"commit",
				"--no-gpg-sign",
				"--message=initial",
				"--quiet",
			]);
			runFixtureGit(primary, ["worktree", "add", "--detach", linked, "--quiet"]);
			const linkedGitDir = runFixtureGit(linked, ["rev-parse", "--absolute-git-dir"]);
			const commonGitDir = runFixtureGit(linked, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			const primaryContents = readFileSync(join(primary, "tracked.txt"), "utf8");
			const linkedContents = readFileSync(join(linked, "tracked.txt"), "utf8");

			initializeFixtureRepository(target, {
				...process.env,
				GIT_DIR: linkedGitDir,
				GIT_WORK_TREE: linked,
				GIT_INDEX_FILE: join(linkedGitDir, "index"),
			});

			assert.equal(existsSync(join(target, ".git")), true, "fixture repository was not initialized at its cwd");
			const coreWorktree = spawnSyncCollect(
				["git", `--git-dir=${commonGitDir}`, "config", "--get-all", "core.worktree"],
				{ env: createGitEnvironment() },
			);
			assert.equal(
				coreWorktree.exitCode,
				1,
				`ambient shared config gained core.worktree=${coreWorktree.stdout.toString().trim()}`,
			);
			const resolvedPrimary = runFixtureGit(primary, ["rev-parse", "--show-toplevel"]);
			assert.equal(
				lstatSync(join(resolvedPrimary, ".git")).isDirectory(),
				true,
				"primary Git commands resolved to a linked worktree",
			);
			assert.equal(readFileSync(join(primary, "tracked.txt"), "utf8"), primaryContents);
			assert.equal(readFileSync(join(linked, "tracked.txt"), "utf8"), linkedContents);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	test("does not execute shell substitutions from Impeccable project paths", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-impeccable-generated-"));
		const marker = join(cwd, "command-injection-marker");
		const crafted = join(cwd, `page-$(touch command-injection-marker).html`);
		try {
			initializeFixtureRepository(cwd);
			writeFileSync(crafted, "<main>source</main>\n");
			const modulePath = join(workflowSkills, "impeccable/scripts/lib/is-generated.mjs");
			const module = (await import(modulePath)) as {
				isGeneratedFile(path: string, options: { cwd: string }): boolean;
			};
			assert.equal(module.isGeneratedFile(crafted, { cwd }), false);
			assert.equal(existsSync(marker), false, "project-controlled filename executed shell syntax");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
