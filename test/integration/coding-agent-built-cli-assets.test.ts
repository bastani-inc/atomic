import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { bunExecutable, moduleDir, readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages/coding-agent");
const fixtureRoot = mkdtempSync(join(packageDir, ".tmp-built-cli-assets-"));
const distDir = join(fixtureRoot, "dist");
const foreignCwd = mkdtempSync(join(tmpdir(), "atomic-built-cli-cwd-"));
const agentDir = join(foreignCwd, "agent");

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
	rmSync(foreignCwd, { recursive: true, force: true });
});

function compileFixture(): void {
	const result = spawnSyncCollect({
		cmd: [
			bunExecutable(),
			"x",
			"--bun",
			"--no-install",
			"tsgo",
			"-p",
			join(packageDir, "tsconfig.build.json"),
			"--outDir",
			distDir,
		],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(result.exitCode, 0, `${result.stdout.toString()}\n${result.stderr.toString()}`);

	cpSync(join(packageDir, "src/modes/interactive/theme"), join(distDir, "modes/interactive/theme"), {
		recursive: true,
		filter: (source) => !source.endsWith(".ts"),
	});
	cpSync(join(packageDir, "src/modes/interactive/assets"), join(distDir, "modes/interactive/assets"), {
		recursive: true,
	});
	cpSync(join(packageDir, "dist/builtin/intercom"), join(distDir, "builtin/intercom"), { recursive: true });
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
	const timeout = setTimeout(() => child.kill(), 15_000);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		readStreamText(child.stdout),
		readStreamText(child.stderr),
	]);
	clearTimeout(timeout);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

describe("coding-agent asset paths", () => {
	test("starts the source CLI from a foreign cwd", async () => {
		const result = await runCli(join(packageDir, "src/cli.ts"));

		assert.equal(result.exitCode, 0, result.output);
		assert.doesNotMatch(result.output, /ENOENT/);
	}, 30_000);

	test("starts the built CLI from a foreign cwd when dist also contains package.json", async () => {
		compileFixture();
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
	}, 60_000);
});
