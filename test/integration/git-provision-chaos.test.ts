import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const CHILD = join(moduleDir(import.meta.url), "fixtures", "git-provision-chaos-child.ts");
/** Real child processes, a stale-lock takeover (2 s), and archive extraction per installer. */
const CHAOS_TEST_TIMEOUT_MS = 120_000;
const INSTALLERS = 8;

interface ChildResult {
	readonly pid: number;
	readonly ok: boolean;
	readonly path?: string;
	readonly version?: string;
	readonly error?: { readonly name: string; readonly code?: string };
}

interface Installer {
	readonly process: SpawnedProcess;
	readonly result: Promise<ChildResult | undefined>;
}

describe.skipIf(process.platform === "win32")("git provisioning under contention and faults (#4322)", () => {
	let root: string;
	let agentDir: string;
	let installDir: string;
	let log: string;
	let archive: string;
	let sha256: string;
	let toolsPath: string;
	const spawned: SpawnedProcess[] = [];

	beforeEach(() => {
		root = makeTempDirectory("atomic-git-chaos-");
		agentDir = join(root, "agent");
		installDir = join(agentDir, "bin", "git");
		log = join(root, "fetch.log");
		writeFileSync(log, "");
		const source = join(root, "archive-src");
		for (const dir of ["bin", "libexec/git-core", "share/git-core/templates", "etc", "ssl"])
			mkdirSync(join(source, dir), { recursive: true });
		writeFileSync(join(source, "bin", "git"), '#!/bin/sh\necho "git version 2.56.0"\n');
		chmodSync(join(source, "bin", "git"), 0o755);
		for (let index = 0; index < 200; index++)
			writeFileSync(join(source, "share", "git-core", `payload-${index}.txt`), `payload ${index}\n`.repeat(200));
		writeFileSync(join(source, "COMPLETE"), "complete\n");
		archive = join(root, "fake-git.tar.gz");
		assert.equal(spawnSync("tar", ["czf", archive, "-C", source, "."]).status, 0);
		sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
		toolsPath = join(root, "tools");
		mkdirSync(toolsPath);
		for (const tool of ["tar", "gzip"]) {
			const located = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
			symlinkSync(located, join(toolsPath, tool));
		}
	});

	afterEach(async () => {
		for (const child of spawned.splice(0)) {
			if (child.exitCode === null) {
				child.kill("SIGCONT");
				child.kill("SIGKILL");
			}
			await child.exited.catch(() => 0);
		}
		removeTempDirectory(root);
	});

	function startInstaller(holdMs = 0, tag = "v0.0.0-chaos"): Installer {
		const child = spawnProcess([bunExecutable(), CHILD], {
			env: {
				...process.env,
				PATH: toolsPath,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "",
				CHAOS_ARCHIVE: archive,
				CHAOS_SHA256: sha256,
				CHAOS_LOG: log,
				CHAOS_HOLD_MS: String(holdMs),
				CHAOS_TAG: tag,
			},
			stdout: "pipe",
			stderr: "inherit",
		});
		spawned.push(child);
		const result = readStreamText(child.stdout).then((text) =>
			text.trim() === "" ? undefined : (JSON.parse(text.trim().split("\n").at(-1) ?? "") as ChildResult),
		);
		return { process: child, result };
	}

	function fetchesBy(): string[] {
		return readFileSync(log, "utf-8")
			.split("\n")
			.filter((line) => line.startsWith("fetch "))
			.map((line) => line.slice("fetch ".length));
	}

	async function waitForFetches(count: number): Promise<void> {
		for (let attempt = 0; fetchesBy().length < count; attempt++) {
			assert.ok(attempt < 600, `expected ${count} fetches, saw ${fetchesBy().length}`);
			await sleep(20);
		}
	}

	/** Polls the published directory: whenever it exists it must be complete. Returns how often it looked. */
	function watchPublication(stop: () => boolean): Promise<number> {
		return (async () => {
			let samples = 0;
			while (!stop()) {
				if (existsSync(installDir)) {
					samples += 1;
					assert.ok(existsSync(join(installDir, "COMPLETE")), "a partial git distribution was published");
					assert.ok(existsSync(join(installDir, "bin", "git")), "a published distribution lacks bin/git");
				}
				await sleep(2);
			}
			return samples;
		})();
	}

	function assertHealthyInstall(): void {
		const run = spawnSync(join(installDir, "bin", "git"), ["--version"], { encoding: "utf-8" });
		assert.equal(run.stdout.trim(), "git version 2.56.0");
		assert.equal(
			readdirSync(join(installDir, "share", "git-core")).filter((name) => name.startsWith("payload-")).length,
			200,
		);
	}

	function leftoverStagingPids(): number[] {
		return readdirSync(join(agentDir, "bin"))
			.filter((name) => name.startsWith(".git-staging-"))
			.map((name) => Number(name.slice(".git-staging-".length).split("-")[1]));
	}

	test(
		"many concurrent installers download once and publish exactly one complete distribution",
		async () => {
			let done = false;
			const watcher = watchPublication(() => done);
			const installers = Array.from({ length: INSTALLERS }, () => startInstaller(200));
			const results = await Promise.all(installers.map((installer) => installer.result));
			done = true;
			assert.ok((await watcher) > 0);

			for (const result of results) {
				assert.equal(result?.ok, true, JSON.stringify(result));
				assert.equal(result?.path, join(installDir, "bin", "git"));
				assert.equal(result?.version, "2.56.0");
			}
			assert.equal(fetchesBy().length, 1, "the install lock lets one installer download");
			assertHealthyInstall();
			assert.deepEqual(leftoverStagingPids(), []);
			assert.equal(existsSync(join(agentDir, "bin", "git.install.lock")), false);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

	test(
		"SIGKILL of the lock holder mid-download publishes nothing partial, and the next installer recovers",
		async () => {
			let done = false;
			const watcher = watchPublication(() => done);
			const victim = startInstaller(30_000);
			await waitForFetches(1);
			const survivors = [startInstaller(), startInstaller(), startInstaller()];
			victim.process.kill("SIGKILL");
			await victim.process.exited;
			const results = await Promise.all(survivors.map((installer) => installer.result));
			done = true;
			await watcher;

			for (const result of results) assert.equal(result?.ok, true, JSON.stringify(result));
			assert.equal(fetchesBy().length, 2, "one takeover download after the killed holder's lock went stale");
			assertHealthyInstall();
			assert.deepEqual(
				leftoverStagingPids().filter((pid) => pid !== victim.process.pid),
				[],
				"only the killed installer may leave a staging directory",
			);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

	test(
		"a SIGSTOPped lock holder is taken over, and when resumed it ends with git or a typed error",
		async () => {
			let done = false;
			const watcher = watchPublication(() => done);
			const stopped = startInstaller(1_000);
			await waitForFetches(1);
			stopped.process.kill("SIGSTOP");
			const replacement = startInstaller();
			const replaced = await replacement.result;
			assert.equal(replaced?.ok, true, JSON.stringify(replaced));
			assertHealthyInstall();
			stopped.process.kill("SIGCONT");
			const resumed = await stopped.result;
			done = true;
			await watcher;

			assert.ok(resumed !== undefined);
			if (resumed.ok) assert.equal(resumed.path, join(installDir, "bin", "git"));
			else assert.match(resumed.error?.name ?? "", /^Git(Unavailable|ProvisionTimeout)Error$/);
			assertHealthyInstall();
			assert.equal(fetchesBy().length, 2);
			assert.deepEqual(leftoverStagingPids(), []);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

	test(
		"a lock stamped in the future by a skewed clock does not block installers",
		async () => {
			const lock = join(agentDir, "bin", "git.install.lock");
			mkdirSync(lock, { recursive: true });
			const future = new Date(Date.now() + 6 * 3_600_000);
			utimesSync(lock, future, future);
			const results = await Promise.all(
				[startInstaller(), startInstaller(), startInstaller()].map((installer) => installer.result),
			);
			for (const result of results) assert.equal(result?.ok, true, JSON.stringify(result));
			assertHealthyInstall();
			assert.equal(fetchesBy().length, 1);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

	test(
		"SIGKILL at any point while a newer release replaces an install leaves a complete tree, and the next run finishes the update",
		async () => {
			const first = await startInstaller(0, "v1").result;
			assert.equal(first?.ok, true, JSON.stringify(first));
			const markerPath = join(installDir, ".atomic-git-release.json");
			const killDelaysMs = [0, 40, 80, 120, 200, 320];
			for (const delayMs of killDelaysMs) {
				const victim = startInstaller(60, "v2");
				await sleep(delayMs);
				victim.process.kill("SIGKILL");
				await victim.process.exited;
				if (existsSync(installDir)) {
					const tag = JSON.parse(readFileSync(markerPath, "utf-8")).tag;
					assert.ok(tag === "v1" || tag === "v2", `unexpected release ${tag} after a kill at ${delayMs} ms`);
					assertHealthyInstall();
				}
				const recovered = await startInstaller(0, "v2").result;
				assert.equal(recovered?.ok, true, JSON.stringify(recovered));
				assert.equal(JSON.parse(readFileSync(markerPath, "utf-8")).tag, "v2");
				assertHealthyInstall();
				assert.deepEqual(
					leftoverStagingPids().filter((pid) => pid !== victim.process.pid),
					[],
				);
				rmSync(installDir, { recursive: true, force: true });
				const reset = await startInstaller(0, "v1").result;
				assert.equal(reset?.ok, true, JSON.stringify(reset));
			}
		},
		CHAOS_TEST_TIMEOUT_MS,
	);
});
