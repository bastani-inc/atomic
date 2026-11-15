import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, readStreamText, spawnProcess } from "../../../test/helpers/runtime.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createGitEnvironment } from "../src/utils/git-env.ts";

const SOURCE = "git:github.com/test/extension";
/** Each case starts several Bun processes that each clone a repository; that cost is structural. */
const CONCURRENT_PROCESSES_TIMEOUT_MS = 120_000;

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: createGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function sourceModule(path: string): string {
	return JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
}

describe("concurrent git package installs (#4964)", () => {
	let tempDir: string;
	let agentDir: string;
	let cloneLog: string;
	let childEnv: Record<string, string | undefined>;

	async function runChildren(count: number, script: string): Promise<string[]> {
		const children = Array.from({ length: count }, () =>
			spawnProcess([bunExecutable(), "--eval", script], { stdout: "pipe", stderr: "pipe", env: childEnv }),
		);
		return Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, code] = await Promise.all([
					readStreamText(child.stdout),
					readStreamText(child.stderr),
					child.exited,
				]);
				assert.equal(code, 0, stderr);
				return stdout.trim();
			}),
		);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-git-concurrent-${process.pid}-${Math.random().toString(36).slice(2)}`);
		const remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");
		cloneLog = join(tempDir, "clones.log");
		mkdirSync(join(remoteDir, "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		git(["init", "--initial-branch=main"], remoteDir);
		git(["config", "--local", "user.email", "test@test.com"], remoteDir);
		git(["config", "--local", "user.name", "Test"], remoteDir);
		git(["config", "--local", "commit.gpgsign", "false"], remoteDir);
		writeFileSync(join(remoteDir, "extensions", "x.ts"), "export default function () {}\n");
		git(["add", "."], remoteDir);
		git(["commit", "-m", "Initial commit"], remoteDir);

		// Serve the source's https URL from the local repository through a slow transport, so a clone
		// stays in flight (its destination already created) while the other processes start.
		const slash = (path: string) => path.replaceAll("\\", "/");
		const serve = `echo clone >> '${slash(cloneLog)}'; sleep 1; git upload-pack '${slash(remoteDir)}'`;
		const globalConfig = join(tempDir, "gitconfig");
		writeFileSync(
			globalConfig,
			[
				`[protocol "ext"]`,
				`\tallow = always`,
				`[url "ext::sh -c ${serve.replaceAll(" ", "% ")}"]`,
				`\tinsteadOf = https://github.com/test/extension`,
				"",
			].join("\n"),
		);
		childEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, [ENV_AGENT_DIR]: agentDir };
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it(
		"lets three resolvers install a missing package once and all load it (#4964)",
		async () => {
			const script = `
				import { DefaultPackageManager } from ${sourceModule("../src/core/package-manager.ts")};
				import { SettingsManager } from ${sourceModule("../src/core/settings-manager.ts")};
				const settingsManager = SettingsManager.inMemory();
				settingsManager.setPackages([${JSON.stringify(SOURCE)}]);
				const manager = new DefaultPackageManager({ cwd: ${JSON.stringify(tempDir)}, agentDir: ${JSON.stringify(agentDir)}, settingsManager });
				const resolved = await manager.resolve(async () => "install");
				console.log(JSON.stringify({
					extensions: resolved.extensions.map((resource) => resource.path.replaceAll("\\\\", "/").split("/").slice(-2).join("/")),
					failures: resolved.installFailures ?? [],
				}));
			`;

			const results = (await runChildren(3, script)).map(
				(line) => JSON.parse(line) as { extensions: string[]; failures: unknown[] },
			);

			for (const result of results) assert.deepEqual(result, { extensions: ["extensions/x.ts"], failures: [] });
			assert.equal(readFileSync(cloneLog, "utf-8").trim().split("\n").length, 1, "one process clones");
		},
		CONCURRENT_PROCESSES_TIMEOUT_MS,
	);

	it(
		"lets two concurrent `atomic install` runs of one source both succeed (#4964)",
		async () => {
			const script = `
				import { handlePackageCommand } from ${sourceModule("../src/package-manager-cli.ts")};
				await handlePackageCommand(["install", ${JSON.stringify(SOURCE)}]);
				console.error("exit code", process.exitCode ?? 0);
				if (process.exitCode) process.exit(process.exitCode);
			`;

			await runChildren(2, script);

			const installed = join(agentDir, "git", "github.com", "test", "extension");
			assert.equal(existsSync(join(installed, "extensions", "x.ts")), true);
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
			assert.deepEqual(settings.packages, [SOURCE]);
		},
		CONCURRENT_PROCESSES_TIMEOUT_MS,
	);
});
