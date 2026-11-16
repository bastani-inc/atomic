import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { bunExecutable, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages/coding-agent");
const fixtureRoot = mkdtempSync(join(packageDir, ".tmp-built-cli-assets-"));
const distDir = join(fixtureRoot, "dist");
const foreignCwd = mkdtempSync(join(tmpdir(), "atomic-built-cli-cwd-"));
const agentDir = join(foreignCwd, "agent");

/**
 * Structural: one real CLI child process, which Bun starts by transpiling the CLI's sources. It exits in about 2 s on
 * an idle machine and took longer than 15 s in a loaded Windows integration run (#5252). A run past this is hung, and
 * is killed so it does not outlive the test.
 */
const CLI_EXIT_LIMIT_MS = 90_000;
/** One CLI run from the sources. */
const SOURCE_CLI_TEST_TIMEOUT_MS = CLI_EXIT_LIMIT_MS + 30_000;
/** Structural: copying the package's build output, thousands of files, which a loaded Windows host is slow to write. */
const DIST_COPY_ALLOWANCE_MS = 60_000;
/** A copy of the build output, then three CLI runs from it. */
const BUILT_CLI_TEST_TIMEOUT_MS = DIST_COPY_ALLOWANCE_MS + 3 * CLI_EXIT_LIMIT_MS;

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
	rmSync(foreignCwd, { recursive: true, force: true });
});

/**
 * The built CLI is the package's own build output (`npm run build`, which also ships every builtin, #3105), copied to
 * a tree of its own. Compiling the package again here instead ran a second `tsc` of the whole package per run, which a
 * loaded host took minutes for, and which its memory limit killed when six runs shared one Linux host (#5252).
 */
function buildFixture(): void {
	assert.ok(existsSync(join(packageDir, "dist/cli.js")), "build the package first: npm run build");
	cpSync(join(packageDir, "dist"), distDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	// The standalone build copies package metadata into dist beside app.js. Running
	// the compiled package CLI from that tree must not turn dist/ into dist/dist/.
	cpSync(join(packageDir, "package.json"), join(distDir, "package.json"));
}

async function runCli(
	cliPath: string,
	packageDirOverride?: { name: "ATOMIC_PACKAGE_DIR" | "PI_PACKAGE_DIR"; value: string },
): Promise<{ exitCode: number; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		ATOMIC_CODING_AGENT_DIR: agentDir,
	};
	delete env.ATOMIC_PACKAGE_DIR;
	delete env.PI_PACKAGE_DIR;
	if (packageDirOverride) env[packageDirOverride.name] = packageDirOverride.value;
	delete env.ATOMIC_CODING_AGENT;

	const child = spawnProcess(
		[
			bunExecutable(),
			cliPath,
			"--provider",
			"github-copilot",
			"--model",
			"claude-opus-5",
			"--thinking",
			"high",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--offline",
		],
		{
			cwd: foreignCwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	child.stdin?.end();
	const startedAt = Date.now();
	let killed = false;
	const timeout = setTimeout(() => {
		killed = true;
		child.kill();
	}, CLI_EXIT_LIMIT_MS);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		readStreamText(child.stdout),
		readStreamText(child.stderr),
	]);
	clearTimeout(timeout);
	const verdict = killed
		? `killed: it did not exit within ${CLI_EXIT_LIMIT_MS} ms`
		: `exited after ${Date.now() - startedAt} ms`;
	return { exitCode, output: `${verdict}\n${stdout}\n${stderr}` };
}

describe("coding-agent asset paths", () => {
	test(
		"starts the source CLI from a foreign cwd",
		async () => {
			const result = await runCli(join(packageDir, "src/cli.ts"));

			assert.equal(result.exitCode, 0, result.output);
			assert.doesNotMatch(result.output, /ENOENT/);
		},
		SOURCE_CLI_TEST_TIMEOUT_MS,
	);

	test(
		"starts the built CLI from a foreign cwd when dist also contains package.json",
		async () => {
			buildFixture();
			assert.equal(existsSync(join(distDir, "modes/interactive/theme/dark.json")), true);

			const result = await runCli(join(distDir, "cli.js"));
			assert.equal(result.exitCode, 0, result.output);
			assert.doesNotMatch(result.output, /dist[\\/]dist[\\/]modes[\\/]interactive[\\/]theme/);
			assert.doesNotMatch(result.output, /ENOENT/);

			const overridden = await runCli(join(distDir, "cli.js"), {
				name: "ATOMIC_PACKAGE_DIR",
				value: fixtureRoot,
			});
			assert.equal(overridden.exitCode, 0, overridden.output);
			assert.doesNotMatch(overridden.output, /ENOENT/);

			const legacyOverride = await runCli(join(distDir, "cli.js"), {
				name: "PI_PACKAGE_DIR",
				value: fixtureRoot,
			});
			assert.equal(legacyOverride.exitCode, 0, legacyOverride.output);
			assert.doesNotMatch(legacyOverride.output, /ENOENT/);
		},
		BUILT_CLI_TEST_TIMEOUT_MS,
	);
});
