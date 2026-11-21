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
import { runInNewContext } from "node:vm";
import { describe, test } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { clearSkillCache, resolveSkills } from "../../packages/subagents/src/agents/skills.js";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const subagentSkills = join(root, "packages/subagents/skills");
const liteparseSkill = join(subagentSkills, "liteparse");
const agentDesktopSkill = join(subagentSkills, "agent-desktop");

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

// vercel-labs/agent-desktop `skills/agent-desktop` at tag v1.3.1 (tree
// ef953179861334f07a7ec948f1d34401de17b9b0) is a discovery stub; its references are
// compiled into the CLI and printed by `agent-desktop skills get`, so only SKILL.md
// is vendored. Its frontmatter is Atomic-owned and its body carries one documented
// adaptation: the "Install and permissions" section. Removing that section must
// reproduce upstream's body byte-for-byte, so a future sync reapplies it instead of
// losing it, and no undocumented drift can hide.
const agentDesktopUpstream = {
	repo: "https://github.com/vercel-labs/agent-desktop",
	path: "skills/agent-desktop",
	ref: "refs/tags/v1.3.1",
	treeSha: "ef953179861334f07a7ec948f1d34401de17b9b0",
} as const;
const agentDesktopSkillBodySha256 = "79f5c7734df27cf7f33de308dc0bc90e9d861eb541d138b2824f01f86d7b52de";
const agentDesktopUpstreamSkillBodySha256 = "8306c49e2d17f9399704aba7ce5c6ca5d7a2b22b8de929bf5284063cbaf135cc";

// pbakaus/impeccable authoritative `.pi/skills/impeccable` distribution:
// skill-v4.9.1 at acb4cfe14470b1fdf51e855431af618d936b7db8 (engine 0.1.24)
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
reference/component-review.md
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
reference/foundations.md
reference/generate.md
reference/harden.md
reference/hooks.md
reference/init.md
reference/ios.md
reference/layout.md
reference/live-setup.md
reference/live.md
reference/mode-operate.md
reference/mode-persuade.md
reference/mode-read.md
reference/new-work.md
reference/onboard.md
reference/operate.md
reference/optimize.md
reference/overdrive.md
reference/polish.md
reference/quieter.md
reference/region-map.md
reference/routing.md
reference/shape.md
reference/typeset.md
reference/visualize.md
scripts/VERSION
scripts/command-metadata.json
scripts/data/font-index-failures.json
scripts/data/font-index.json
scripts/engine-checksums.txt
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
const IMPECCABLE_ENGINE_VERSION = "0.1.24";
const IMPECCABLE_ENGINE_ASSETS = [
	"impeccable-darwin-arm64",
	"impeccable-darwin-x64",
	"impeccable-linux-x64",
	"impeccable-linux-arm64",
	"impeccable-windows-x64.exe",
];

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

/** Splits a SKILL.md into its YAML frontmatter and the body after the closing `---` line. */
function splitFrontmatter(contents: string): { frontmatter: string; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(contents);
	assert.ok(match, "SKILL.md must open with a YAML frontmatter block");
	return { frontmatter: match[1], body: match[2] };
}

function trackedModes(path: string): string[] {
	const staged = spawnSyncCollect(["git", "ls-files", "--stage", "--", path], {
		cwd: root,
		env: createGitEnvironment(),
	});
	assert.equal(staged.exitCode, 0, staged.stderr.toString());
	return staged.stdout
		.toString()
		.trim()
		.split("\n")
		.map((line) => {
			const [metadata, filePath] = line.split("\t");
			return `${metadata.split(" ")[0]} ${filePath}`;
		});
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
	test("discovers the renamed subagent skills and removes the old name", async () => {
		clearSkillCache();
		const result = await resolveSkills(["agent-browser", "agent-desktop", "liteparse", "effective-liteparse"], root);
		assert.deepEqual(result.resolved.map((skill) => skill.name).sort(), [
			"agent-browser",
			"agent-desktop",
			"liteparse",
		]);
		assert.deepEqual(result.missing, ["effective-liteparse"]);
		assert.match(readFileSync(join(subagentSkills, "liteparse/SKILL.md"), "utf8"), /^---\r?\nname: liteparse\r?$/m);
		assert.equal(existsSync(join(subagentSkills, "effective-liteparse")), false);
	});

	test(
		"discovers the general-purpose skills without the workflows package",
		async () => {
			const agentDir = mkdtempSync(join(tmpdir(), "atomic-builtin-skill-discovery-"));
			try {
				const loader = new DefaultResourceLoader({
					cwd: agentDir,
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					builtinPackagePaths: [join(root, "packages/subagents")],
				});
				await loader.reload();
				const names = new Set(loader.getSkills().skills.map((skill) => skill.name));
				for (const name of [
					"bro",
					"create-spec",
					"how",
					"impeccable",
					"prompt-engineer",
					"research-codebase",
					"show-me",
					"skill-creator",
					"teach",
					"unslop",
					"why",
				]) {
					assert.ok(names.has(name), `missing builtin skill: ${name}`);
				}
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		BUILTIN_LOADER_RELOAD_TIMEOUT_MS,
	);

	test("bundles meaningful upstream skill content without Atomic scaffolding", () => {
		assertFiles(join(subagentSkills, "agent-browser"), ["SKILL.md"]);
		assertFiles(agentDesktopSkill, ["SKILL.md"]);
		assertFiles(join(subagentSkills, "liteparse"), ["SKILL.md", "scripts/search.py"]);
		assertFiles(join(subagentSkills, "impeccable"), [
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
			"scripts/engine-checksums.txt",
			"scripts/data/font-index.json",
			"scripts/live-browser.js",
			"scripts/live-browser-ignores.js",
			"scripts/modern-screenshot.umd.js",
		]);
		assert.match(readFileSync(join(subagentSkills, "impeccable/SKILL.md"), "utf8"), /^version: 4\.9\.1\r?$/m);
		assert.equal(
			readFileSync(join(subagentSkills, "impeccable/scripts/VERSION"), "utf8").trim(),
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
			assert.equal(existsSync(join(subagentSkills, "impeccable", stale)), false, `stale upstream file: ${stale}`);
		}
		assertNoScaffolding(join(subagentSkills, "agent-browser"));
		assertNoScaffolding(agentDesktopSkill);
		assertNoScaffolding(join(subagentSkills, "liteparse"));
		assertNoScaffolding(join(subagentSkills, "impeccable"));
		assertPacked(join(root, "packages/subagents"), [
			"skills/agent-browser/SKILL.md",
			"skills/liteparse/scripts/search.py",
			"skills/agent-desktop/SKILL.md",
			"skills/impeccable/scripts/impeccable",
			"skills/impeccable/scripts/impeccable.cmd",
			"skills/impeccable/scripts/VERSION",
			"skills/impeccable/scripts/engine-checksums.txt",
		]);
	});

	test("ships the exact Impeccable 4.9.1 tree with the pi distribution's launcher paths and modes", () => {
		const skillRoot = join(subagentSkills, "impeccable");
		assert.deepEqual(collectFiles(skillRoot, [], skillRoot).sort(), [...impeccableTree]);
		// The `.pi` distribution names the launcher by its pi-native skill path and
		// pins shortcuts under the `/` command prefix; `.agents` would print
		// `.agents/...` paths and `$` shortcuts into every agent transcript.
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		const { frontmatter } = splitFrontmatter(canonicalText(skill));
		for (const [key, value] of [
			["github-repo", "https://github.com/pbakaus/impeccable"],
			["github-path", ".pi/skills/impeccable"],
			["github-ref", "refs/tags/skill-v4.9.1"],
			["github-tree-sha", "f6a534b7ea9b5b189495c4b4af819f7c2bc9b083"],
		] as const) {
			assert.ok(frontmatter.split("\n").includes(`    ${key}: ${value}`));
		}
		assert.match(skill, /`<skill-base-dir>\/scripts\/impeccable context`/u);
		assert.match(skill, /\.pi\/skills\/impeccable\/scripts\/impeccable <verb>/u);
		assert.match(skill, /creates or removes a standalone `\/<command>` shortcut/u);
		assert.doesNotMatch(skill, /\.agents\/skills\/impeccable|\$<command>|\.mjs/u);

		const packed = packedPaths(join(root, "packages/subagents")).filter((path) => !isLocalEngineBinary(path));
		assert.deepEqual(
			packed.filter((path) => path.startsWith("skills/impeccable/")),
			impeccableTree.map((path) => `skills/impeccable/${path}`),
		);

		const staged = spawnSyncCollect(["git", "ls-files", "--stage", "--", "packages/subagents/skills/impeccable"], {
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
					`${impeccableExecutables.has(path) ? "100755" : "100644"} packages/subagents/skills/impeccable/${path}`,
			),
		);
		assert.equal(
			entries.some((entry) => entry.includes("/scripts/bin/")),
			false,
			"the per-platform engine binary must never be tracked",
		);
	});

	test("pins the agent-browser v0.43.0 discovery stub and provenance", () => {
		const skillRoot = join(subagentSkills, "agent-browser");
		assert.deepEqual(collectFiles(skillRoot, [], skillRoot), ["SKILL.md"]);
		const { frontmatter, body } = splitFrontmatter(canonicalText(readFileSync(join(skillRoot, "SKILL.md"))));
		assert.equal(
			sha256(body.replace(/^\n/u, "")),
			"f7d40c8f0e8794240d9b1728e9b2ea195c6044045c120986c45d216d4804a333",
		);
		assert.match(frontmatter, /^name: agent-browser$/mu);
		assert.match(frontmatter, /^hidden: true$/mu);
		assert.match(frontmatter, /^allowed-tools: Bash\(agent-browser:\*\)$/mu);
		for (const [key, value] of [
			["github-repo", "https://github.com/vercel-labs/agent-browser"],
			["github-path", "skills/agent-browser"],
			["github-ref", "refs/tags/v0.43.0"],
			["github-tree-sha", "cd4185523189fb04c1d24bea0100b6aa2ce7421e"],
		] as const) {
			assert.ok(frontmatter.split("\n").includes(`    ${key}: ${value}`));
		}
		assert.deepEqual(trackedModes("packages/subagents/skills/agent-browser"), [
			"100644 packages/subagents/skills/agent-browser/SKILL.md",
		]);
		assert.deepEqual(
			packedPaths(join(root, "packages/subagents")).filter((path) => path.startsWith("skills/agent-browser/")),
			["skills/agent-browser/SKILL.md"],
		);
	});

	test("ships the pstack teach, unslop and bro bodies of cursor/plugins main 35a90942", () => {
		// Body SHA-256 of cursor/plugins pstack/skills/<name>/SKILL.md at that commit, after the frontmatter. The pstack
		// skills record the upstream commit in github-tree-sha. how and why are Atomic adaptations and are not pinned here.
		// teach keeps the sentence upstream dropped when it collapsed `why` into a single pass (#1236): Atomic's `why`
		// still sweeps every evidence category by default, so teach must still ask it to stay narrow.
		const teachKeepsWhyNarrow =
			"Keep `why` narrow by default since its full sweep is slow: put the narrowing in the ask itself (a scoped question, git plus a source or two) so `why` records the skipped categories per its own contract, and widen it only when the reasons are the point.";
		const pstack: ReadonlyArray<
			readonly [name: string, bodySha256: string, userInvokedOnly: boolean, adaptation: string | undefined]
		> = [
			["teach", "e8d8607040e6824f0fcd20c168b416b2f835c0611079d22a281b4447c04dc4b6", true, teachKeepsWhyNarrow],
			["unslop", "4e2c21fbdfcdec160e3249bc433e7bf6d500f9269449bec14dcd8161bb16a563", false, undefined],
			["bro", "638186a185a29dbaa188e976ab505c0e0e630d83ebc37b0ec83feba342aecb1f", true, undefined],
		];
		for (const [name, bodySha256, userInvokedOnly, adaptation] of pstack) {
			const skillRoot = join(subagentSkills, name);
			const { frontmatter, body } = splitFrontmatter(canonicalText(readFileSync(join(skillRoot, "SKILL.md"))));
			let upstreamBody = body;
			if (adaptation !== undefined) {
				assert.ok(body.includes(` ${adaptation}`), `${name} must keep its documented adaptation`);
				upstreamBody = body.replace(` ${adaptation}`, "");
			}
			assert.equal(sha256(upstreamBody.replace(/^\n/u, "")), bodySha256, `${name} body drifted from upstream`);
			assert.match(frontmatter, new RegExp(`^name: ${name}$`, "mu"));
			assert.equal(/^disable-model-invocation: true$/mu.test(frontmatter), userInvokedOnly, name);
			for (const [key, value] of [
				["github-repo", "https://github.com/cursor/plugins"],
				["github-path", `pstack/skills/${name}`],
				["github-ref", "refs/heads/main"],
				["github-tree-sha", "35a90942a7f02e1ebbc2443643179815f2147954"],
			] as const) {
				assert.ok(frontmatter.split("\n").includes(`    ${key}: ${value}`), `${name} ${key}`);
			}
			assert.deepEqual(collectFiles(skillRoot, [], skillRoot), ["LICENSE.txt", "SKILL.md"]);
		}
		// Atomic keeps unslop model-invocable, so its description keeps the phrase upstream dropped with the flag.
		assert.match(
			readFileSync(join(subagentSkills, "unslop/SKILL.md"), "utf8"),
			/^description: Cut AI tells from any writing\. Must always apply\.\r?$/mu,
		);
	});

	test("ships the humanlayer/skills show-me body with only its documented opener adaptation", () => {
		const skillRoot = join(subagentSkills, "show-me");
		const { frontmatter, body } = splitFrontmatter(canonicalText(readFileSync(join(skillRoot, "SKILL.md"))));
		// Upstream opens the artifact with macOS `open`; Atomic uses a portable opener through its bash tool.
		const atomicOpener = [
			"Use Atomic's `bash` tool to run:",
			"",
			"```bash",
			'if [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then',
			'  open "path/to/show-me-{description}.html"',
			'elif [ "$(uname -s)" = "Linux" ] && command -v xdg-open >/dev/null 2>&1; then',
			'  xdg-open "path/to/show-me-{description}.html"',
			"else",
			"  printf 'Open this file: %s\\n' \"path/to/show-me-{description}.html\"",
			"fi",
			"```",
		].join("\n");
		const upstreamOpener = ["```", "Bash(open path/to/show-me-{description}.html)", "```"].join("\n");
		assert.ok(body.includes(atomicOpener), "show-me must keep Atomic's portable opener");
		// humanlayer/skills plugins/show-me/skills/show-me/SKILL.md at main 4d69d20f, after the frontmatter.
		assert.equal(
			sha256(body.replace(atomicOpener, upstreamOpener).replace(/^\n/u, "")),
			"56419a7c9342221f9840ea11b63b51ad16c39ce2377cb5646b6093fc060384b2",
			"show-me diverges from upstream beyond its documented opener adaptation",
		);
		assert.match(frontmatter, /^disable-model-invocation: true$/mu);
		for (const [key, value] of [
			["github-repo", "https://github.com/humanlayer/skills"],
			["github-path", "plugins/show-me/skills/show-me"],
			["github-ref", "refs/heads/main"],
			["github-tree-sha", "362200ac2fb3c17b765049444e88de73767e6d08"],
		] as const) {
			assert.ok(frontmatter.split("\n").includes(`    ${key}: ${value}`), key);
		}
		assert.deepEqual(collectFiles(skillRoot, [], skillRoot), ["LICENSE.txt", "SKILL.md"]);
	});

	test("credits the tdd skill's MIT sources and carries mattpocock/skills v1.3.2's tautological-test example", () => {
		// The provenance records v1.3.2 as the upstream release reviewed. From it Atomic took only the tautological-test
		// anti-pattern. Declined on purpose, so a later sync should not treat their absence as drift: the reshaping into a
		// reference with pre-agreed seams and the removal of the refactor stage, the deletion of deep-modules.md,
		// interface-design.md and refactoring.md, the GLOSSARY.md convention, calls to the upstream codebase-design and
		// code-review skills, and agents/openai.yaml.
		const skillRoot = join(subagentSkills, "tdd");
		const { frontmatter } = splitFrontmatter(canonicalText(readFileSync(join(skillRoot, "SKILL.md"))));
		assert.match(frontmatter, /^license: MIT\. LICENSE\.txt has complete terms$/mu);
		for (const [key, value] of [
			["github-repo", "https://github.com/mattpocock/skills"],
			["github-path", "skills/engineering/tdd"],
			["github-ref", "refs/tags/v1.3.2"],
			["github-tree-sha", "667dbdd00c09d0e2189e082986e6a4d61a67c2a6"],
		] as const) {
			assert.ok(frontmatter.split("\n").includes(`    ${key}: ${value}`), key);
		}
		// test-audit.md is adapted from OpenClaw's test-audit skill, so both copyright notices ship.
		const license = canonicalText(readFileSync(join(skillRoot, "LICENSE.txt")));
		assert.match(license, /^Copyright \(c\) 2026 Matt Pocock$/mu);
		assert.match(license, /^Copyright \(c\) 2026 OpenClaw Foundation$/mu);
		assert.equal(license.match(/^Permission is hereby granted, free of charge/gmu)?.length, 2);
		// From the tautological-tests heading to the end of upstream's tests.md at v1.3.2.
		const tests = canonicalText(readFileSync(join(skillRoot, "tests.md")));
		assert.equal(
			sha256(tests.slice(tests.indexOf("**Tautological tests**"))),
			"41fbaa3b2c1ebfaec8b951c27346f7c7281bc253189795cb9e77f80848bdce74",
		);
		assert.match(
			readFileSync(join(skillRoot, "SKILL.md"), "utf8"),
			/^\[ \] Expected values are independent literals, not recomputed from the code\r?$/mu,
		);
	});

	test("ships the pinned tmux helpers with the socket directory rename and the strict wait deadline", () => {
		// main, not the latest calendar release: v2026.11.5's skills/tmux tree (dd5ddfca) lacks seven of the nine script fixes.
		const skillRoot = join(subagentSkills, "tmux");
		const skill = canonicalText(readFileSync(join(skillRoot, "SKILL.md")));
		const { frontmatter } = splitFrontmatter(skill);
		assert.match(frontmatter, /^license: MIT\. LICENSE\.txt has complete terms$/mu);
		for (const [key, value] of [
			["github-repo", "https://github.com/openclaw/openclaw"],
			["github-path", "skills/tmux"],
			["github-ref", "refs/heads/main"],
			["github-tree-sha", "65bac7c67ae8d4acaf2d8cd2e7e3fc6e7ff90803"],
		] as const) {
			assert.ok(frontmatter.split("\n").includes(`    "${key}": "${value}",`), key);
		}
		const license = canonicalText(readFileSync(join(skillRoot, "LICENSE.txt")));
		assert.match(license, /^Copyright \(c\) 2026 OpenClaw Foundation$/mu);
		assert.equal(license.match(/^Permission is hereby granted, free of charge/gmu)?.length, 1);
		assert.deepEqual(collectFiles(skillRoot, [], skillRoot).sort(), [
			"LICENSE.txt",
			"SKILL.md",
			"scripts/find-sessions.sh",
			"scripts/wait-for-text.sh",
		]);
		assert.deepEqual(trackedModes("packages/subagents/skills/tmux"), [
			"100644 packages/subagents/skills/tmux/LICENSE.txt",
			"100644 packages/subagents/skills/tmux/SKILL.md",
			"100755 packages/subagents/skills/tmux/scripts/find-sessions.sh",
			"100755 packages/subagents/skills/tmux/scripts/wait-for-text.sh",
		]);
		// The session helper matches its upstream once the socket rename is reversed.
		// The wait helper is pinned with Atomic's deadline handling and its sliced wait for worker lines applied.
		const expectedScripts: ReadonlyArray<readonly [path: string, sha256: string]> = [
			["scripts/find-sessions.sh", "5cd5f80305c7a08871d62988e908cd366a22d1c6e4b4857b77a64f52955b59e3"],
			["scripts/wait-for-text.sh", "4eae228c7ecbe17b638e530caeed0f114db788a2bf71a148098bc443324eee04"],
		];
		for (const [path, expected] of expectedScripts) {
			const normalized = canonicalText(readFileSync(join(skillRoot, path)))
				.replaceAll("ATOMIC_TMUX_SOCKET_DIR", "OPENCLAW_TMUX_SOCKET_DIR")
				.replaceAll("atomic-tmux-sockets", "openclaw-tmux-sockets");
			assert.equal(sha256(normalized), expected, `${path} differs from its pinned revision and adaptations`);
		}
		// Upstream's completion-marker example, with Atomic's marker name.
		assert.ok(skill.includes(`marker="ATOMIC_DONE_\${nonce}"`));
	});

	test("tracks the skill-creator scripts with the modes of anthropics/skills tree 3cf9a8db", () => {
		const skillCreatorRoot = "packages/subagents/skills/skill-creator/";
		const executableScripts = new Set(
			[
				"aggregate_benchmark",
				"generate_report",
				"improve_description",
				"package_skill",
				"quick_validate",
				"run_eval",
				"run_loop",
			].map((name) => `scripts/${name}.py`),
		);
		const modes = new Map(
			trackedModes(skillCreatorRoot).map((entry) => {
				const [mode, path] = entry.split(" ");
				return [path.slice(skillCreatorRoot.length), mode] as const;
			}),
		);
		for (const script of executableScripts) {
			assert.ok(modes.has(script), `untracked skill-creator script: ${script}`);
		}
		for (const [path, mode] of modes) {
			assert.equal(mode, executableScripts.has(path) ? "100755" : "100644", `skill-creator mode drift: ${path}`);
		}
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

	test("pins the agent-desktop v1.3.1 discovery stub with only its documented adaptation", () => {
		assert.deepEqual(collectFiles(agentDesktopSkill, [], agentDesktopSkill), ["SKILL.md"]);
		const { frontmatter, body } = splitFrontmatter(canonicalText(readFileSync(join(agentDesktopSkill, "SKILL.md"))));
		assert.equal(sha256(body), agentDesktopSkillBodySha256, "agent-desktop SKILL.md body drifted");
		const start = body.indexOf("## Install and permissions\n");
		const end = body.indexOf("## Shell syntax\n");
		assert.ok(start >= 0 && end > start, "lost Atomic's agent-desktop install and permissions section");
		const adaptation = body.slice(start, end);
		assert.match(adaptation, /npm install -g agent-desktop/u);
		assert.match(adaptation, /agent-desktop status/u);
		assert.match(adaptation, /agent-desktop permissions --guide/u);
		assert.match(adaptation, /do not run `npx skills add`/u);
		assert.match(adaptation, /`agent-desktop sandbox create` only when the user explicitly asks/u);
		assert.equal(
			sha256(body.slice(0, start) + body.slice(end)),
			agentDesktopUpstreamSkillBodySha256,
			"agent-desktop SKILL.md body diverges from upstream beyond the documented adaptation",
		);
		assert.match(body, /agent-desktop skills get desktop/u);
		assert.doesNotMatch(body, /cua-driver|PyAutoGUI|pyautogui/iu);
		assert.match(frontmatter, /^name: agent-desktop$/mu);
		assert.match(frontmatter, /^hidden: true$/mu);
		assert.match(frontmatter, /^allowed-tools: Bash\(agent-desktop:\*\), Bash\(npx agent-desktop:\*\)$/mu);
		const frontmatterLines = frontmatter.split("\n");
		for (const [key, value] of [
			["github-repo", agentDesktopUpstream.repo],
			["github-path", agentDesktopUpstream.path],
			["github-ref", agentDesktopUpstream.ref],
			["github-tree-sha", agentDesktopUpstream.treeSha],
		] as const) {
			assert.ok(frontmatterLines.includes(`    ${key}: ${value}`), `frontmatter metadata.${key} must be ${value}`);
		}
		assert.deepEqual(trackedModes("packages/subagents/skills/agent-desktop"), [
			"100644 packages/subagents/skills/agent-desktop/SKILL.md",
		]);
		assert.deepEqual(
			packedPaths(join(root, "packages/subagents")).filter((path) => path.startsWith("skills/agent-desktop/")),
			["skills/agent-desktop/SKILL.md"],
		);
		assert.equal(existsSync(join(subagentSkills, "cua-driver")), false, "the old cua-driver skill is still bundled");
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
		assert.deepEqual(
			trackedModes("packages/subagents/skills/liteparse"),
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
		assertRegularTree(agentDesktopSkill);
		assertRegularTree(join(subagentSkills, "liteparse"));
		assertRegularTree(join(subagentSkills, "impeccable"));
	});

	test("tracks every bundled skill file instead of silently ignoring part of a synced tree", () => {
		const skillFiles = collectFiles(subagentSkills);
		assert.ok(skillFiles.length > 100, `expected a complete bundled skill inventory, saw ${skillFiles.length}`);
		// `--no-index` reports ignore rules even for already-tracked paths, so a broad
		// rule (such as the Python packaging `lib/`) cannot silently truncate a sync.
		const ignored = spawnSyncCollect(["git", "check-ignore", "--no-index", "--stdin"], {
			cwd: root,
			env: createGitEnvironment(),
			stdin: Buffer.from(`${skillFiles.join("\n")}\n`),
		});
		assert.equal(ignored.stdout.toString().trim(), "", "bundled skill files are excluded by .gitignore");
		const tracked = spawnSyncCollect(["git", "ls-files", "packages/subagents/skills/impeccable"], {
			cwd: root,
			env: createGitEnvironment(),
		});
		assert.equal(tracked.exitCode, 0, tracked.stderr.toString());
		for (const path of [
			"scripts/VERSION",
			"scripts/impeccable",
			"scripts/impeccable.cmd",
			"scripts/engine-checksums.txt",
			"scripts/data/font-index.json",
		]) {
			assert.ok(
				tracked.stdout.toString().includes(`packages/subagents/skills/impeccable/${path}\n`),
				`untracked bundled file: ${path}`,
			);
		}
	});

	test("keeps synced live-preview session ids on the CSPRNG outside secure contexts", () => {
		const dom = readFileSync(join(subagentSkills, "impeccable/scripts/live-browser-dom.js"), "utf8");
		const session = readFileSync(join(subagentSkills, "impeccable/scripts/live-browser-session.js"), "utf8");
		// Upstream's last-resort fallback (no usable crypto) still draws these ids
		// from Math.random, including the randomUUID helper 4.7.0 added to the
		// session script; they name live-edit sessions, so Atomic keeps the CodeQL
		// js/insecure-randomness fix from the 4.1.1 sync on id8, makeId, and
		// randomUUID. Any Math.random call in either script fails the check.
		assert.match(dom, /crypto\.getRandomValues\(new Uint8Array\(4\)\)/u, "id8 lost its CSPRNG fallback");
		assert.doesNotMatch(dom, /Math\.random\(/u, "id8 fell back to Math.random");
		assert.match(session, /\(root\.crypto \|\| crypto\)\.getRandomValues\(new Uint8Array\(4\)\)/u);
		assert.match(session, /\(c \|\| crypto\)\.getRandomValues\(bytes\)/u, "randomUUID lost its CSPRNG fill");
		assert.doesNotMatch(session, /Math\.random\(/u, "a session id helper fell back to Math.random");
	});

	test("keeps the synced live overlay loading its helper scripts from the origin that served live.js", () => {
		const live = readFileSync(join(subagentSkills, "impeccable/scripts/live-browser.js"), "utf8");
		// Upstream sets the src of the detector and screenshot scripts the overlay adds to `'http://localhost:' + PORT`.
		// Atomic resolves both against the origin the page loaded live.js from, so no script URL is written out with
		// plain http and both load from the origin the page's script-src already allows for live.js.
		assert.match(live, /const LIVE_SCRIPT = document\.currentScript;/u, "live.js no longer reads its own script");
		assert.match(live, /helperScriptUrl\('\/detect\.js'\)/u, "the detector script lost the helper origin");
		assert.match(
			live,
			/helperScriptUrl\('\/modern-screenshot\.js'\)/u,
			"the screenshot script lost the helper origin",
		);
		assert.doesNotMatch(live, /\.src = ['"`]http:/u, "a script src is written out with plain http");
	});

	test("resolves the synced live overlay's helper scripts against the live.js the page loaded, on any helper port", () => {
		const live = readFileSync(join(subagentSkills, "impeccable/scripts/live-browser.js"), "utf8");
		const start = live.indexOf("  function helperScriptUrl(path) {");
		const end = live.indexOf("\n  }\n", start);
		assert.ok(start !== -1 && end !== -1, "the live overlay lost helperScriptUrl");
		const source = `${live.slice(start, end + 4)}\nhelperScriptUrl(path);`;
		/** The URL the overlay gives `/detect.js`, run as it runs in a page with these scripts. */
		const detectUrl = (port: number, running: string | null, scripts: readonly string[] = []): string | null =>
			runInNewContext(source, {
				URL,
				PORT: port,
				path: "/detect.js",
				LIVE_SCRIPT: running === null ? null : { src: running },
				document: { querySelectorAll: () => scripts.map((src) => ({ src })) },
			});

		assert.equal(detectUrl(8400, "http://localhost:8400/live.js?token=t"), "http://localhost:8400/detect.js");
		// A browser leaves the default port out of a script's URL: live.js on port 80 is http://localhost/live.js.
		assert.equal(detectUrl(80, "http://localhost/live.js?token=t"), "http://localhost/detect.js");
		assert.equal(detectUrl(443, "https://localhost/live.js?token=t"), "https://localhost/detect.js");
		// No running script element (a module script): the page's live.js script on the helper's port.
		assert.equal(
			detectUrl(8400, null, ["http://localhost:3000/app.js", "http://localhost:8400/live.js?token=t"]),
			"http://localhost:8400/detect.js",
		);
		assert.equal(detectUrl(8400, "http://localhost:3000/bundle.js", ["http://localhost:3000/bundle.js"]), null);
	});

	test("keeps the vendored Impeccable launchers offline by default", () => {
		const posix = readFileSync(join(subagentSkills, "impeccable/scripts/impeccable"), "utf8");
		const windows = readFileSync(join(subagentSkills, "impeccable/scripts/impeccable.cmd"), "utf8");
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
	});

	test("keeps the pinned Impeccable engine verified against the shipped SHA-256 manifest", () => {
		const scripts = join(subagentSkills, "impeccable/scripts");
		const posix = readFileSync(join(scripts, "impeccable"), "utf8");
		const windows = readFileSync(join(scripts, "impeccable.cmd"), "utf8");
		const manifest = readFileSync(join(scripts, "engine-checksums.txt"), "utf8");
		const digests = new Map<string, string>();
		for (const line of manifest.split(/\r?\n/u)) {
			if (line === "" || line.startsWith("#")) continue;
			const [version, asset, digest, ...extra] = line.split(/\s+/u);
			assert.deepEqual(extra, [], `malformed engine checksum line: ${line}`);
			assert.equal(version, IMPECCABLE_ENGINE_VERSION, `engine checksum for another version: ${line}`);
			digests.set(asset, digest);
		}
		for (const asset of IMPECCABLE_ENGINE_ASSETS) {
			assert.match(digests.get(asset) ?? "", /^[0-9a-f]{64}$/u, `no SHA-256 pinned for ${asset}`);
		}
		assert.match(posix, /^manifest="\$dir\/engine-checksums\.txt"\r?$/mu, "sh launcher stopped reading the manifest");
		assert.match(posix, /checksum mismatch downloading/u, "sh launcher stopped comparing the download");
		assert.match(posix, /refusing the unverified download/u, "sh launcher stopped failing closed");
		assert.match(
			windows,
			/^set "manifest=%~dp0engine-checksums\.txt"\r?$/mu,
			"cmd launcher stopped reading the manifest",
		);
		assert.match(windows, /refusing the unverified download/u, "cmd launcher stopped failing closed");
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
