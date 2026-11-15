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

	/** A manager whose progress events land in `events`. */
	function createObservedManager(events: ProgressEvent[]): DefaultPackageManager {
		const manager = createManager();
		manager.setProgressCallback((event) => events.push(event));
		return manager;
	}

	function recloneNotices(events: ProgressEvent[]): ProgressEvent[] {
		return events.filter(
			(event) => event.type === "progress" && /not a complete git checkout/.test(event.message ?? ""),
		);
	}

	/** Replaces the manager's command runner with `hook`, which may call the real runner it receives. */
	function hookCommands(
		manager: DefaultPackageManager,
		hook: (
			run: (args: string[], options?: { cwd?: string }) => Promise<void>,
			args: string[],
			options?: { cwd?: string },
		) => Promise<void>,
	): void {
		const internals = manager as unknown as {
			runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
		};
		const runCommand = internals.runCommand.bind(manager);
		internals.runCommand = (command, args, options) =>
			hook((nextArgs, nextOptions) => runCommand(command, nextArgs, nextOptions), args, options);
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

		await createObservedManager(events).install(SOURCE);

		assertValidCheckout();
		assert.deepEqual(
			recloneNotices(events).map((event) => event.action),
			["install"],
		);
	});

	it("repairs an installed package with a broken checkout on update (#4962)", async () => {
		leaveInterruptedClone();
		settingsManager.setPackages([SOURCE]);
		const events: ProgressEvent[] = [];

		await createObservedManager(events).update();

		assertValidCheckout();
		assert.deepEqual(
			recloneNotices(events).map((event) => event.action),
			["update"],
		);
	});

	it("reclones a clone killed after it fetched but before it checked out (#4962)", async () => {
		leaveInterruptedClone();
		git(["fetch", "origin"], targetDir);
		git(["remote", "set-head", "origin", "-a"], targetDir);

		await createManager().install(SOURCE);

		assertValidCheckout();
	});

	it("reclones a checkout that has commits but no remote branch (#4962)", async () => {
		leaveInterruptedClone();
		git(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "--allow-empty", "-m", "local"], targetDir);

		await createManager().install(SOURCE);

		assertValidCheckout();
	});

	it("reclones a directory that is not a git checkout without running git in it (#4962)", async () => {
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "leftover.txt"), "x");
		const events: ProgressEvent[] = [];

		await createObservedManager(events).install(SOURCE);

		assertValidCheckout();
		assert.equal(existsSync(join(targetDir, "leftover.txt")), false);
		assert.deepEqual(
			events.filter((event) => event.type === "progress").map((event) => event.message),
			recloneNotices(events).map((event) => event.message),
		);
		assert.equal(recloneNotices(events).length, 1);
	});

	it("keeps a complete checkout whose update fails (#4962)", async () => {
		await createManager().install(SOURCE);
		rmSync(remoteDir, { recursive: true, force: true });
		settingsManager.setPackages([SOURCE]);

		await assert.rejects(createManager().update());

		assert.equal(readFileSync(join(targetDir, "extension.ts"), "utf-8"), "// v1");
	});

	it("moves an installed package to the remote's new commit when it is installed again (#4962)", async () => {
		await createManager().install(SOURCE);
		writeFileSync(join(remoteDir, "extension.ts"), "// v2");
		git(["commit", "-am", "Second commit"], remoteDir);

		await createManager().install(SOURCE);

		assert.equal(readFileSync(join(targetDir, "extension.ts"), "utf-8"), "// v2");
	});

	it("installs a configured package that is missing on update without a notice (#4962)", async () => {
		settingsManager.setPackages([SOURCE]);
		const events: ProgressEvent[] = [];

		await createObservedManager(events).update();

		assertValidCheckout();
		assert.deepEqual(recloneNotices(events), []);
	});

	it("removes nothing and creates no directories for a package that is not installed (#4962)", async () => {
		await createManager().remove(SOURCE);

		assert.equal(existsSync(join(agentDir, "git")), false);
	});

	it("clones into a staging directory next to the target and sweeps stale ones (#4962)", async () => {
		const parent = dirname(targetDir);
		mkdirSync(parent, { recursive: true });
		const stale = join(parent, ".extension.atomic-clone-stale");
		const live = join(parent, ".extension.atomic-clone-live");
		const otherPackage = join(parent, "other");
		mkdirSync(stale);
		mkdirSync(live);
		mkdirSync(otherPackage);
		const dayAndAHalfAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
		const almostADayAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
		utimesSync(stale, dayAndAHalfAgo, dayAndAHalfAgo);
		utimesSync(otherPackage, dayAndAHalfAgo, dayAndAHalfAgo);
		utimesSync(live, almostADayAgo, almostADayAgo);

		const events: ProgressEvent[] = [];
		const manager = createObservedManager(events);
		const cloneDestinations: string[] = [];
		hookCommands(manager, async (run, args, options) => {
			if (args[0] === "clone") {
				cloneDestinations.push(args[args.length - 1]!);
				assert.equal(existsSync(targetDir), false, "the target appears only after the clone succeeds");
			}
			await run(args, options);
		});

		await manager.install(SOURCE);

		assert.equal(cloneDestinations.length, 1);
		assert.equal(dirname(cloneDestinations[0]!), parent);
		assert.notEqual(cloneDestinations[0], targetDir);
		assert.equal(existsSync(cloneDestinations[0]!), false);
		assert.equal(existsSync(stale), false, "a staging directory older than a day is removed");
		assert.equal(existsSync(live), true, "a recent staging directory may belong to a running install");
		assert.equal(existsSync(otherPackage), true, "only staging directories of this package are swept");
		assert.deepEqual(
			events.filter((event) => event.type === "progress"),
			[],
		);
		rmSync(live, { recursive: true });
		rmSync(otherPackage, { recursive: true });
		assertValidCheckout();
	});

	it("uses the checkout of an install that finished first while this one cloned (#4962)", async () => {
		const manager = createManager();
		hookCommands(manager, async (run, args, options) => {
			// An install that does not take the lock (an older version) places its clone first.
			if (args[0] === "clone") git(["clone", remoteDir, targetDir], tempDir);
			await run(args, options);
		});

		await manager.install(SOURCE);

		assertValidCheckout();
	});

	it("fails instead of using an incomplete directory that appeared while it cloned (#4962)", async () => {
		const manager = createManager();
		hookCommands(manager, async (run, args, options) => {
			if (args[0] === "clone") {
				mkdirSync(targetDir, { recursive: true });
				writeFileSync(join(targetDir, "partial.txt"), "x");
			}
			await run(args, options);
		});

		await assert.rejects(manager.install(SOURCE));

		assert.deepEqual(readdirSync(targetDir), ["partial.txt"], "the directory it did not create is kept");
		assert.deepEqual(readdirSync(dirname(targetDir)), ["extension"], "its own staging directory is removed");
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

	it("reports a package that is neither in settings nor installed as not found (#4962)", async () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await handlePackageCommand(["remove", SOURCE]);

		assert.equal(process.exitCode, 1);
		assert.match(error.mock.calls.flat().join("\n"), /No matching package found/);
	});

	it("removes an installed package that is in settings (#4962)", async () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await handlePackageCommand(["install", SOURCE]);

		await handlePackageCommand(["remove", SOURCE]);

		assert.equal(existsSync(targetDir), false);
		assert.equal(process.exitCode ?? 0, 0);
		assert.match(log.mock.calls.flat().join("\n"), new RegExp(`Removed ${SOURCE}$`, "m"));
	});
});
