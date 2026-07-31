/**
 * P4 probes for the three adapted upstream fixes whose blast radius is a path
 * that already worked: context-file discovery (`cced6a21`), RPC bash dispatch
 * (`5d548ae9`) and resource metadata retention across a reload (`66eead65`).
 *
 * `packages/coding-agent/test/pi-0.83.0-direct-fixes.test.ts` already asserts
 * each fix against a hand-built fixture. These probe the same behaviour one
 * level out, where a regression would actually be felt: a worktree produced by
 * real `git worktree add` rather than a synthetic `.git` layout, an RPC bash
 * command with no extension handler installed, and package-sourced resources
 * read back after the reload that discovered them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { loadProjectContextFiles } from "../../packages/coding-agent/src/core/resource-loader-context-files.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

/**
 * Run git against an explicit checkout.
 *
 * `createGitEnvironment` strips the repository-local variables a hook exports;
 * this suite itself runs inside a linked worktree, so an inherited `GIT_DIR`
 * would silently redirect the fixture commands at *this* repository.
 */
function git(cwd: string, ...args: string[]): void {
	const result = spawnSyncCollect(["git", ...args], {
		cwd,
		env: createGitEnvironment({
			GIT_AUTHOR_NAME: "Probe",
			GIT_AUTHOR_EMAIL: "probe@example.invalid",
			GIT_COMMITTER_NAME: "Probe",
			GIT_COMMITTER_EMAIL: "probe@example.invalid",
			GIT_CONFIG_GLOBAL: join(cwd, ".gitconfig-absent"),
			GIT_CONFIG_SYSTEM: join(cwd, ".gitconfig-absent"),
		}),
	});
	assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

test("a real linked worktree nested under its own main repository loads each context file once", () => {
	const root = temporaryDirectory("atomic-real-worktree-");
	const repository = join(root, "repo");
	mkdirSync(repository, { recursive: true });
	git(repository, "init", "--initial-branch=main");
	writeFileSync(join(repository, "AGENTS.md"), "main checkout instructions");
	git(repository, "add", "AGENTS.md");
	git(repository, "commit", "-m", "seed");
	// Nested *inside* the main checkout: the layout where the ancestor walk used
	// to find the main repository's own copy on the way up and load it twice.
	git(repository, "worktree", "add", "-b", "feature", "nested-worktree");
	const worktree = join(repository, "nested-worktree");
	writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });

	const files = loadProjectContextFiles({ cwd: worktree, agentDir });

	assert.deepEqual(
		files.map((file) => file.content),
		["worktree instructions"],
	);
	assert.equal(new Set(files.map((file) => file.path)).size, files.length, "a context file was listed twice");
});

test("a plain subdirectory of a real repository still inherits the repository context file", () => {
	const root = temporaryDirectory("atomic-real-repo-");
	const repository = join(root, "repo");
	const nested = join(repository, "packages", "thing");
	mkdirSync(nested, { recursive: true });
	git(repository, "init", "--initial-branch=main");
	writeFileSync(join(repository, "AGENTS.md"), "repository instructions");
	git(repository, "add", "AGENTS.md");
	git(repository, "commit", "-m", "seed");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });

	const files = loadProjectContextFiles({ cwd: nested, agentDir });

	// The guard must only suppress the *duplicate* main-checkout copy; ordinary
	// ancestor inheritance is the path that already worked.
	assert.deepEqual(
		files.map((file) => file.content),
		["repository instructions"],
	);
});

test("RPC bash reaches a user_bash handler and still runs a real command without one", async () => {
	const intercepted: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("user_bash", async (event) => {
					intercepted.push(event.command);
					if (!event.command.startsWith("handled")) return undefined;
					return { result: { output: "from handler", exitCode: 0, cancelled: false, truncated: false } };
				});
			},
		],
	});
	await harness.session.bindExtensions({ shutdownHandler: () => {} });
	try {
		const handle = createRpcCommandHandler({
			runtimeHost: { session: harness.session, services: { agentDir: harness.tempDir } } as never,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: () => {},
		});

		const handled = await handle({ id: "rpc-handled", type: "bash", command: "handled command" });
		// A handler that declines must not swallow the command: the real executor
		// still runs it, which is the path that worked before the fix.
		const declined = await handle({ id: "rpc-declined", type: "bash", command: "echo not-handled" });

		assert.deepEqual(intercepted, ["handled command", "echo not-handled"]);
		assert.deepEqual((handled as { data: { output: string; exitCode: number } }).data, {
			output: "from handler",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const declinedData = (declined as { data: { output: string; exitCode: number } }).data;
		assert.equal(declinedData.exitCode, 0);
		assert.match(declinedData.output, /not-handled/u);
	} finally {
		harness.cleanup();
	}
});

/** A theme file the real loader accepts, derived from the shipped dark theme. */
function writeProbeTheme(path: string, name: string): void {
	const source = fileURLToPath(
		new URL("../../packages/coding-agent/src/modes/interactive/theme/dark.json", import.meta.url),
	);
	const theme = JSON.parse(readFileSync(source, "utf8")) as { name: string };
	writeFileSync(path, JSON.stringify({ ...theme, name }));
}

test("skills, prompts and themes keep their package source after a reload and a later extendResources", async () => {
	const root = temporaryDirectory("atomic-reload-metadata-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const packageDir = join(root, "probe-package");
	mkdirSync(join(packageDir, "skills", "packaged-skill"), { recursive: true });
	mkdirSync(join(packageDir, "prompts"), { recursive: true });
	mkdirSync(join(packageDir, "themes"), { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "probe-package",
			pi: { skills: ["./skills"], prompts: ["./prompts"], themes: ["./themes"] },
		}),
	);
	writeFileSync(
		join(packageDir, "skills", "packaged-skill", "SKILL.md"),
		"---\nname: packaged-skill\ndescription: Packaged\n---\nContent",
	);
	writeFileSync(join(packageDir, "prompts", "packaged-prompt.md"), "---\ndescription: Packaged\n---\nContent");
	writeProbeTheme(join(packageDir, "themes", "packaged-theme.json"), "packaged-theme");

	// A later extendResources pass, from an unrelated directory: before the fix
	// this second pass ran without the reload's metadata and every packaged
	// resource fell back to a plain local source.
	const extraSkillDir = join(root, "extra-skills", "extra-skill");
	mkdirSync(extraSkillDir, { recursive: true });
	writeFileSync(join(extraSkillDir, "SKILL.md"), "---\nname: extra-skill\ndescription: Extra\n---\nContent");

	const loader = new DefaultResourceLoader({ cwd, agentDir, builtinPackagePaths: [packageDir] });
	await loader.reload();

	const packagedSourceInfo = () => ({
		skill: loader.getSkills().skills.find((skill) => skill.name === "packaged-skill")?.sourceInfo,
		prompt: loader.getPrompts().prompts.find((prompt) => prompt.name === "packaged-prompt")?.sourceInfo,
		theme: loader.getThemes().themes.find((theme) => theme.name === "packaged-theme")?.sourceInfo,
	});

	const afterReload = packagedSourceInfo();
	for (const [kind, sourceInfo] of Object.entries(afterReload)) {
		assert.ok(sourceInfo, `${kind} was not discovered from the package`);
		assert.equal(sourceInfo.origin, "package", `${kind} lost its package origin at reload`);
		assert.equal(sourceInfo.source, packageDir, `${kind} lost its package source at reload`);
	}

	await loader.extendResources({
		skillPaths: [
			{
				path: extraSkillDir,
				metadata: { source: "extension:extra", scope: "temporary", origin: "top-level", baseDir: extraSkillDir },
			},
		],
	});

	assert.deepEqual(packagedSourceInfo(), afterReload, "extendResources dropped the reload's package metadata");
	assert.equal(
		loader.getSkills().skills.find((skill) => skill.name === "extra-skill")?.sourceInfo?.source,
		"extension:extra",
		"the extending pass lost its own metadata",
	);
});
