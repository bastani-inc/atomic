import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { IntercomBrokerControl } from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { LOCAL_SESSIONS_STORAGE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { joinTeamWith, leaveTeamWith } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { bunExecutable, makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Chaos for `atomic team join`/`leave`: concurrent writers of one settings file are SIGKILLed and SIGSTOPped at
 * arbitrary points. Invariants: the file always parses, unrelated settings survive, `storage` is never set without
 * the local sessions pin (sessions never move to the team database by accident), a referenced token file exists and
 * holds the token, every failure is typed, and the next join and leave succeed with no manual step.
 */

const ROUNDS = 12;
/** A killed writer's settings lock expires after proper-lockfile's 10 s staleness window. */
const LOCK_STALE_MS = 10_000;
/** Bun child processes loading the libSQL adapter, killed and restarted every round, plus the lock expiry. */
const CHAOS_TEST_TIMEOUT_MS = 240_000;
const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const fixture = join(repoRoot, "test/fixtures/team-settings-churn.ts");
const packageRoot = join(repoRoot, "packages/storage-libsql");
const UNRELATED = { theme: "dark", retry: { enabled: false } };
const control = { restartIntercomBroker: async () => ({ status: "not-running" }) } as unknown as IntercomBrokerControl;

let root: string;
let agentDir: string;
let project: string;
let databaseDirectory: string;

beforeEach(() => {
	root = makeTempDirectory("team-chaos-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	databaseDirectory = makeLibsqlDirectory();
	for (const name of ["ATOMIC_STORAGE", "ATOMIC_PROFILE", "ATOMIC_TEAM_URL", "ATOMIC_TEAM_TOKEN"])
		vi.stubEnv(name, "");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

interface Churner {
	readonly child: ChildProcess;
	readonly lines: string[];
}

function churn(role: "team" | "unrelated", url: string, tokenFile: string): Churner {
	const child = spawn(bunExecutable(), [fixture, role, agentDir, project, url, tokenFile], {
		cwd: repoRoot,
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	child.stdout?.setEncoding("utf8").on("data", (text: string) => lines.push(...text.split("\n").filter(Boolean)));
	child.stderr?.setEncoding("utf8").on("data", (text: string) => lines.push(`stderr ${text.trim()}`));
	return { child, lines };
}

function kill(churner: Churner): Promise<void> {
	if (churner.child.exitCode !== null || churner.child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit) => {
		churner.child.once("exit", () => resolveExit());
		churner.child.kill("SIGKILL");
	});
}

function assertInvariants(token: string, round: number): void {
	const text = readFileSync(join(agentDir, "settings.json"), "utf8");
	let settings: { storage?: { secrets?: { authToken?: { file: string } } }; sessions?: { storage?: object } };
	try {
		settings = JSON.parse(text);
	} catch {
		assert.fail(`round ${round}: settings.json does not parse: ${JSON.stringify(text.slice(0, 80))}`);
	}
	assert.deepEqual(
		{ theme: (settings as typeof UNRELATED).theme, retry: (settings as typeof UNRELATED).retry },
		UNRELATED,
		`round ${round}: unrelated settings survive`,
	);
	assert.equal(
		settings.storage !== undefined,
		settings.sessions?.storage !== undefined,
		`round ${round}: storage and the local sessions pin are written and removed together`,
	);
	if (settings.sessions?.storage !== undefined) assert.deepEqual(settings.sessions.storage, LOCAL_SESSIONS_STORAGE);
	const reference = settings.storage?.secrets?.authToken?.file;
	if (reference !== undefined) {
		const path = resolve(root, reference);
		assert.ok(existsSync(path), `round ${round}: the referenced token file exists`);
		assert.equal(readFileSync(path, "utf8"), token, `round ${round}: the referenced token file holds the token`);
	}
}

test.skipIf(process.platform === "win32")(
	"SIGKILL and SIGSTOP during concurrent team joins, leaves and unrelated writes never corrupt or split the settings (#4320)",
	async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ ...UNRELATED, packages: [packageRoot] }, null, 2),
		);
		const databasePath = join(databaseDirectory, "team.sqlite");
		await (await openNodeSqliteDatabase(databasePath)).close();
		const url = pathToFileURL(databasePath).href;
		const tokenFile = join(root, "token");
		writeFileSync(tokenFile, "chaos-token\n");
		let completed = 0;
		const outputs: string[] = [];
		for (let round = 1; round <= ROUNDS; round++) {
			const churners = [
				churn("team", url, tokenFile),
				churn("team", url, tokenFile),
				churn("unrelated", url, tokenFile),
			];
			await vi.waitFor(
				() => {
					if (churners.some((churner) => churner.lines.length === 0)) throw new Error("writers not started");
				},
				{ timeout: 30_000, interval: 20 },
			);
			await sleep(50 + ((round * 97) % 400));
			if (round % 3 === 0) {
				churners[0]!.child.kill("SIGSTOP");
				await sleep(300);
				churners[0]!.child.kill("SIGCONT");
			}
			await Promise.all(churners.map(kill));
			for (const churner of churners) {
				outputs.push(...churner.lines);
				completed += churner.lines.filter((line) => line === "ok").length;
			}
			assertInvariants("chaos-token", round);
		}
		assert.deepEqual(
			outputs.filter(
				(line) => line.startsWith("UNTYPED") || line.startsWith("stderr") || line.includes("settings-unreadable"),
			),
			[],
		);
		assert.ok(completed >= ROUNDS, `writers completed ${completed} steps`);

		const context = { loadControl: async () => control };
		const recover = async <T>(action: () => Promise<T>): Promise<T> => {
			const deadline = Date.now() + LOCK_STALE_MS + 5_000;
			for (;;) {
				try {
					return await action();
				} catch (error) {
					assert.ok(isTeamProfileError(error), String(error));
					if (!error.retryable || Date.now() > deadline) throw error;
					await sleep(250);
				}
			}
		};
		const joined = await recover(() => joinTeamWith({ url, tokenFile, agentDir, cwd: project }, "sdk", context));
		assert.deepEqual(joined.sessionsStorage, LOCAL_SESSIONS_STORAGE);
		await recover(() => leaveTeamWith({ agentDir, cwd: project }, context));
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.storage, undefined);
		assert.equal(settings.sessions, undefined);
		assert.deepEqual(
			readdirSync(agentDir).filter((name) => name.endsWith(".tmp")).length <= ROUNDS * 3,
			true,
			"at most one interrupted temporary file per killed writer",
		);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a reader never sees a half-written settings file while team join rewrites a large one (#4320)",
	async () => {
		const large = { ...UNRELATED, packages: [packageRoot], padding: "x".repeat(32 * 1024 * 1024) };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(large));
		const databasePath = join(databaseDirectory, "team.sqlite");
		await (await openNodeSqliteDatabase(databasePath)).close();
		const url = pathToFileURL(databasePath).href;
		const tokenFile = join(root, "token");
		writeFileSync(tokenFile, "reader-token\n");
		const reader = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs"); let reads = 0, torn = 0; const end = Date.now() + 15000;
				 process.stdin.on("data", () => { process.stdout.write(JSON.stringify({ reads, torn })); process.exit(0); });
				 (function loop() { for (let i = 0; i < 20; i++) { try { JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { torn++; } reads++; }
				   if (Date.now() < end) setImmediate(loop); })();`,
				join(agentDir, "settings.json"),
			],
			{ stdio: ["pipe", "pipe", "inherit"] },
		);
		let report = "";
		reader.stdout?.setEncoding("utf8").on("data", (text: string) => {
			report += text;
		});
		const context = { loadControl: async () => control };
		for (let round = 0; round < 4; round++) {
			await joinTeamWith({ url, tokenFile, agentDir, cwd: project }, "sdk", context);
			await leaveTeamWith({ agentDir, cwd: project }, context);
		}
		const exited = new Promise((resolveExit) => reader.once("exit", resolveExit));
		reader.stdin?.write("report\n");
		await exited;
		const { reads, torn } = JSON.parse(report) as { reads: number; torn: number };
		assert.ok(reads > 0, "the reader read the settings file");
		assert.equal(torn, 0, `${torn} of ${reads} reads saw a half-written settings file`);
	},
	CHAOS_TEST_TIMEOUT_MS,
);
