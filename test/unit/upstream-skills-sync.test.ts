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

// pbakaus/impeccable authoritative `.pi/skills/impeccable` distribution:
// skill-v4.3.1 at cd12f8660e2dde57b9615c8a6b8ea674101f9cfc (engine 0.1.5)
// prior skill-v4.1.1 `.agents` distribution at 5a149f3fdb1b5793f10567233b1dcab98fc305fd
//
// `scripts/bin/<os>-<arch>/` is deliberately absent: the engine binary is
// gitignored, and the launcher downloads and checksum-verifies it on first run.
const impeccableTree = `
SKILL.md
reference/adapt.md
reference/adapt.native.md
reference/android.md
reference/animate.md
reference/audit.md
reference/audit.native.md
reference/bolder.md
reference/clarify.md
reference/colorize.md
reference/craft-floor.md
reference/craft.md
reference/critique.md
reference/degraded/asset-producer.md
reference/degraded/documenter.md
reference/degraded/finish-reviewer.md
reference/degraded/manual-edit-applier.md
reference/delight.md
reference/distill.md
reference/doctor.md
reference/document.md
reference/extract.md
reference/harden.md
reference/hooks.md
reference/init.md
reference/ios.md
reference/layout.md
reference/live-setup.md
reference/live.md
reference/new-work.md
reference/onboard.md
reference/operate.md
reference/optimize.md
reference/overdrive.md
reference/polish.md
reference/quieter.md
reference/routing.md
reference/shape.md
reference/typeset.md
reference/visualize.md
scripts/VERSION
scripts/command-metadata.json
scripts/data/font-index-failures.json
scripts/data/font-index.json
scripts/impeccable
scripts/impeccable.cmd
scripts/live-browser-dom.js
scripts/live-browser-ignores.js
scripts/live-browser-session.js
scripts/live-browser.js
scripts/modern-screenshot.umd.js
`
	.trim()
	.split("\n");
const impeccableExecutables = new Set(["scripts/impeccable"]);
const IMPECCABLE_ENGINE_VERSION = "0.1.5";

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
		if (isLocalEngineBinary(relative(base, child))) continue;
		if (entry.isDirectory()) collectFiles(child, into, base);
		else into.push(relative(base, child).replace(/\\/g, "/"));
	}
	return into;
}

/**
 * A developer who ran the Impeccable launcher may hold a platform binary under
 * the gitignored `scripts/bin/`. It is never tracked or shipped from CI, so
 * inventory checks skip it rather than fail on one machine.
 */
function isLocalEngineBinary(relativePath: string): boolean {
	return /^(?:.*\/impeccable\/)?scripts\/bin(?:\/|$)/u.test(relativePath.replace(/\\/g, "/"));
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
		const result = resolveSkills(["agent-browser", "liteparse", "effective-liteparse"], root);
		assert.deepEqual(result.resolved.map((skill) => skill.name).sort(), ["agent-browser", "liteparse"]);
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
		assertFiles(join(subagentSkills, "agent-browser"), ["SKILL.md"]);
		assertFiles(join(subagentSkills, "liteparse"), ["SKILL.md", "scripts/search.py"]);
		assertFiles(join(workflowSkills, "impeccable"), [
			"SKILL.md",
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
			"scripts/VERSION",
			"scripts/command-metadata.json",
			"scripts/impeccable",
			"scripts/impeccable.cmd",
			"scripts/data/font-index.json",
			"scripts/live-browser.js",
			"scripts/live-browser-ignores.js",
			"scripts/modern-screenshot.umd.js",
		]);
		assert.match(readFileSync(join(workflowSkills, "impeccable/SKILL.md"), "utf8"), /^version: 4\.3\.1\r?$/m);
		assert.equal(
			readFileSync(join(workflowSkills, "impeccable/scripts/VERSION"), "utf8").trim(),
			IMPECCABLE_ENGINE_VERSION,
			"the launcher's pinned engine version must match the synced skill",
		);
		for (const stale of [
			"agents",
			"reference/brand.md",
			"reference/codex.md",
			"reference/interaction-design.md",
			"reference/product.md",
			"scripts/context.mjs",
			"scripts/hook-before-edit.mjs",
			"scripts/live-poll.mjs",
			"scripts/live/ui-core.mjs",
			"scripts/lib/provider.mjs",
		]) {
			assert.equal(existsSync(join(workflowSkills, "impeccable", stale)), false, `stale upstream file: ${stale}`);
		}
		assertNoScaffolding(join(subagentSkills, "agent-browser"));
		assertNoScaffolding(join(subagentSkills, "liteparse"));
		assertNoScaffolding(join(workflowSkills, "impeccable"));
		assertPacked(join(root, "packages/subagents"), [
			"skills/agent-browser/SKILL.md",
			"skills/liteparse/scripts/search.py",
		]);
		assertPacked(join(root, "packages/workflows"), [
			"skills/impeccable/scripts/impeccable",
			"skills/impeccable/scripts/impeccable.cmd",
			"skills/impeccable/scripts/VERSION",
		]);
	});

	test("ships the exact Impeccable 4.3.1 tree with the pi distribution's launcher paths and modes", () => {
		const skillRoot = join(workflowSkills, "impeccable");
		assert.deepEqual(collectFiles(skillRoot, [], skillRoot).sort(), [...impeccableTree]);
		// The `.pi` distribution names the launcher by its pi-native skill path and
		// pins shortcuts under the `/` command prefix; `.agents` would print
		// `.agents/...` paths and `$` shortcuts into every agent transcript.
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		assert.match(skill, /`<skill-base-dir>\/scripts\/impeccable context`/u);
		assert.match(skill, /\.pi\/skills\/impeccable\/scripts\/impeccable <verb>/u);
		assert.match(skill, /creates or removes a standalone `\/<command>` shortcut/u);
		assert.doesNotMatch(skill, /\.agents\/skills\/impeccable|\$<command>|\.mjs/u);

		const packed = packedPaths(join(root, "packages/workflows")).filter((path) => !isLocalEngineBinary(path));
		assert.deepEqual(
			packed.filter((path) => path.startsWith("skills/impeccable/")),
			impeccableTree.map((path) => `skills/impeccable/${path}`),
		);

		const staged = spawnSyncCollect(["git", "ls-files", "--stage", "--", "packages/workflows/skills/impeccable"], {
			cwd: root,
			env: createGitEnvironment(),
		});
		assert.equal(staged.exitCode, 0, staged.stderr.toString());
		const entries = staged.stdout
			.toString()
			.trim()
			.split("\n")
			.map((line) => {
				const [metadata, path] = line.split("\t");
				return `${metadata.split(" ")[0]} ${path}`;
			});
		assert.deepEqual(
			entries,
			impeccableTree.map(
				(path) =>
					`${impeccableExecutables.has(path) ? "100755" : "100644"} packages/workflows/skills/impeccable/${path}`,
			),
		);
		assert.equal(
			entries.some((entry) => entry.includes("/scripts/bin/")),
			false,
			"the per-platform engine binary must never be tracked",
		);
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
		assertRegularTree(join(subagentSkills, "agent-browser"));
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
		for (const path of [
			"scripts/VERSION",
			"scripts/impeccable",
			"scripts/impeccable.cmd",
			"scripts/data/font-index.json",
		]) {
			assert.ok(
				tracked.stdout.toString().includes(`packages/workflows/skills/impeccable/${path}\n`),
				`untracked bundled file: ${path}`,
			);
		}
	});

	test("keeps synced live-preview session ids on the CSPRNG outside secure contexts", () => {
		const dom = readFileSync(join(workflowSkills, "impeccable/scripts/live-browser-dom.js"), "utf8");
		const session = readFileSync(join(workflowSkills, "impeccable/scripts/live-browser-session.js"), "utf8");
		// Upstream's insecure-context fallback (plain-http LAN preview) draws these
		// ids from Math.random; they name live-edit sessions, so Atomic keeps the
		// CodeQL js/insecure-randomness fix from the 4.1.1 sync on both helpers.
		assert.match(dom, /crypto\.getRandomValues\(new Uint8Array\(4\)\)/u, "id8 lost its CSPRNG fallback");
		assert.doesNotMatch(dom, /Math\.random\(\)\.toString\(16\)/u, "id8 fell back to Math.random");
		assert.match(session, /\(root\.crypto \|\| crypto\)\.getRandomValues\(new Uint8Array\(4\)\)/u);
		assert.doesNotMatch(session, /Math\.random\(\)\.toString\(16\)\.slice\(2, 10\)/u);
	});

	test("keeps the vendored Impeccable launchers offline by default", () => {
		const posix = readFileSync(join(workflowSkills, "impeccable/scripts/impeccable"), "utf8");
		const windows = readFileSync(join(workflowSkills, "impeccable/scripts/impeccable.cmd"), "utf8");
		// The engine binary carries upstream's concept-roll telemetry ping and the
		// daily `npx impeccable update` check. A skill vendored inside an Atomic
		// release cannot self-update, and #2382 removed the ping outright, so both
		// launchers default the engine's opt-out switches on before any exec.
		for (const setting of ["IMPECCABLE_NO_TELEMETRY", "IMPECCABLE_NO_UPDATE_CHECK"]) {
			assert.match(
				posix,
				new RegExp(`^: "\\$\\{${setting}:=1\\}"\\r?$`, "mu"),
				`${setting} default missing from sh launcher`,
			);
			assert.match(posix, new RegExp(`^export .*\\b${setting}\\b`, "mu"), `${setting} not exported by sh launcher`);
			assert.match(
				windows,
				new RegExp(`^if not defined ${setting} set "${setting}=1"\\r?$`, "mu"),
				`${setting} default missing from cmd launcher`,
			);
		}
		const firstExec = posix.search(/^\s*exec /mu);
		assert.ok(firstExec > posix.indexOf("IMPECCABLE_NO_UPDATE_CHECK"), "policy env must be set before any exec");
		assert.ok(
			windows.indexOf("IMPECCABLE_NO_UPDATE_CHECK") < windows.indexOf("goto run"),
			"cmd policy precedes dispatch",
		);
		assert.match(posix, /engine-v\$version\/\$asset"\r?\n/u, "download stays pinned to the VERSION file");
		assert.match(posix, /\$url\.sha256/u, "downloads stay checksum-verified");
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
});
