import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import type { ProgressEvent } from "../src/core/package-manager-types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { createGitEnvironment } from "../src/utils/git-env.ts";

const SOURCE = "git:github.com/test/extension";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: createGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

describe("interrupted git package installs (#4962)", () => {
	let tempDir: string;
	let remoteDir: string;
	let agentDir: string;
	let targetDir: string;
	let settingsManager: SettingsManager;
	let previousGlobalConfig: string | undefined;
	let previousAgentDir: string | undefined;

	function createManager(): DefaultPackageManager {
		return new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	}

	/** What a clone killed after `git init` and `remote add` leaves behind: a repository with a remote and no commits. */
	function leaveInterruptedClone(): void {
		mkdirSync(targetDir, { recursive: true });
		git(["init"], targetDir);
		git(["remote", "add", "origin", "https://github.com/test/extension"], targetDir);
	}

	function assertValidCheckout(): void {
		assert.equal(readFileSync(join(targetDir, "extension.ts"), "utf-8"), "// v1");
		assert.equal(git(["rev-parse", "HEAD"], targetDir), git(["rev-parse", "HEAD"], remoteDir));
		assert.deepEqual(
			readdirSync(dirname(targetDir)).filter((entry) => entry !== "extension"),
			[],
			"no staging directory is left next to the checkout",
		);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-git-interrupted-${process.pid}-${Math.random().toString(36).slice(2)}`);
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");
		targetDir = join(agentDir, "git", "github.com", "test", "extension");
		mkdirSync(remoteDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		git(["init", "--initial-branch=main"], remoteDir);
		git(["config", "--local", "user.email", "test@test.com"], remoteDir);
		git(["config", "--local", "user.name", "Test"], remoteDir);
		git(["config", "--local", "commit.gpgsign", "false"], remoteDir);
		writeFileSync(join(remoteDir, "extension.ts"), "// v1");
		git(["add", "extension.ts"], remoteDir);
		git(["commit", "-m", "Initial commit"], remoteDir);

		// Serve the source's https URL from the local repository, as a git daemon would.
		const globalConfig = join(tempDir, "gitconfig");
		writeFileSync(
			globalConfig,
			`[url "${pathToFileURL(remoteDir).href}"]\n\tinsteadOf = https://github.com/test/extension\n`,
		);
		previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		previousAgentDir = process.env[ENV_AGENT_DIR];
		settingsManager = SettingsManager.inMemory();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		process.exitCode = 0;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reclones a checkout left by an interrupted clone when the install is retried (#4962)", async () => {
		leaveInterruptedClone();
		const events: ProgressEvent[] = [];
		const manager = createManager();
		manager.setProgressCallback((event) => events.push(event));

		await manager.install(SOURCE);

		assertValidCheckout();
		const notices = events.filter(
			(event) => event.type === "progress" && /not a complete git checkout/.test(event.message ?? ""),
		);
		assert.equal(notices.length, 1);
	});

	it("repairs an installed package with a broken checkout on update (#4962)", async () => {
		leaveInterruptedClone();
		settingsManager.setPackages([SOURCE]);

		await createManager().update();

		assertValidCheckout();
	});

	it("clones into a staging directory next to the target and sweeps stale ones (#4962)", async () => {
		const parent = dirname(targetDir);
		mkdirSync(parent, { recursive: true });
		const stale = join(parent, ".extension.atomic-clone-stale");
		const live = join(parent, ".extension.atomic-clone-live");
		mkdirSync(stale);
		mkdirSync(live);
		const dayAndAHalfAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
		utimesSync(stale, dayAndAHalfAgo, dayAndAHalfAgo);

		const manager = createManager();
		const internals = manager as unknown as {
			runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
		};
		const runCommand = internals.runCommand.bind(manager);
		const cloneDestinations: string[] = [];
		internals.runCommand = async (command, args, options) => {
			if (args[0] === "clone") {
				const destination = args[args.length - 1]!;
				cloneDestinations.push(destination);
				assert.equal(existsSync(targetDir), false, "the target appears only after the clone succeeds");
			}
			await runCommand(command, args, options);
		};

		await manager.install(SOURCE);

		assert.equal(cloneDestinations.length, 1);
		assert.equal(dirname(cloneDestinations[0]!), parent);
		assert.notEqual(cloneDestinations[0], targetDir);
		assert.equal(existsSync(cloneDestinations[0]!), false);
		assert.equal(existsSync(stale), false, "a staging directory older than a day is removed");
		assert.equal(existsSync(live), true, "a recent staging directory may belong to a running install");
		rmSync(live, { recursive: true });
		assertValidCheckout();
	});

	it("uses the checkout of an install that finished first while this one cloned (#4962)", async () => {
		const manager = createManager();
		const internals = manager as unknown as {
			runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
		};
		const runCommand = internals.runCommand.bind(manager);
		internals.runCommand = async (command, args, options) => {
			// An install that does not take the lock (an older version) places its clone first.
			if (args[0] === "clone") git(["clone", remoteDir, targetDir], tempDir);
			await runCommand(command, args, options);
		};

		await manager.install(SOURCE);

		assertValidCheckout();
	});

	it("lets concurrent installs of one source both succeed (#4962)", async () => {
		await Promise.all([createManager().install(SOURCE), createManager().install(SOURCE)]);

		assertValidCheckout();
	});

	it("removes a leftover checkout of a package missing from settings (#4962)", async () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		leaveInterruptedClone();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await handlePackageCommand(["remove", SOURCE]);

		assert.equal(existsSync(targetDir), false);
		assert.equal(process.exitCode ?? 0, 0);
		assert.equal(error.mock.calls.length, 0);
		assert.match(log.mock.calls.flat().join("\n"), /Removed .*extension.*not in your settings/);
	});
});
