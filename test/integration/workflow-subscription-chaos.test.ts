import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-subscription-chaos.ts");
const COMMAND = [process.execPath, "--import", "jiti/register", FIXTURE];
const EVENTS = 60;
const MAX_CONCURRENT = 4;
const HANDLER_DELAY_MS = "25";
/** Structural: each scenario starts, faults and restarts real Node processes on a SQLite journal. */
const CHAOS_SCENARIO_TIMEOUT_MS = 240_000;
const PROCESS_PHASE_TIMEOUT_MS = 90_000;

type Handled = ReadonlyMap<string, readonly string[]>;

async function handledByLabel(directory: string): Promise<Handled> {
	const path = join(directory, "handled.txt");
	const lines = (await fileExists(path)) ? (await readText(path)).trim().split("\n").filter(Boolean) : [];
	const byLabel = new Map<string, string[]>();
	for (const line of lines) {
		const [label, id] = line.split(" ") as [string, string];
		byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
	}
	return byLabel;
}

async function waitForHandled(directory: string, label: string, count: number): Promise<void> {
	const deadline = Date.now() + PROCESS_PHASE_TIMEOUT_MS;
	while (((await handledByLabel(directory)).get(label)?.length ?? 0) < count) {
		assert.ok(Date.now() < deadline, `${label} handled fewer than ${count} events`);
		await sleep(10);
	}
}

function fixture(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSyncCollect([...COMMAND, ...args], { cwd: ROOT, env, timeout: PROCESS_PHASE_TIMEOUT_MS });
}

function lastJson<T>(output: Uint8Array | string): T {
	return JSON.parse(output.toString().trim().split("\n").at(-1)!) as T;
}

function records(directory: string, runId: string): { processed: string[]; eventRecords: number } {
	const result = fixture(["records", directory, runId, "inspector"]);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	return lastJson(result.stdout);
}

function integrity(directory: string): string {
	const database = new DatabaseSync(join(directory, "journal.sqlite"), { readOnly: true });
	try {
		return String((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
	} finally {
		database.close();
	}
}

const allIds = Array.from({ length: EVENTS }, (_, index) => `e${index}`);

test(
	"SIGKILL mid-subscription, then resume: recorded events are never handled again and none are lost (#4311)",
	async () => {
		const directory = makeTempDirectory("subscription-chaos-kill-");
		const runId = "4311c0de-0000-4000-8000-00000000000a";
		const first = spawnProcess(
			[...COMMAND, "run", directory, runId, "first", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
			{
				cwd: ROOT,
			},
		);
		try {
			await waitForHandled(directory, "first", EVENTS / 3);
			first.kill("SIGKILL");
			await first.exited;
			assert.equal(integrity(directory), "ok");
			const beforeResume = records(directory, runId);
			assert.ok(beforeResume.processed.length > 0 && beforeResume.processed.length < EVENTS);

			const resumed = fixture([
				"resume",
				directory,
				runId,
				"second",
				String(EVENTS),
				HANDLER_DELAY_MS,
				String(MAX_CONCURRENT),
			]);
			assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
			assert.deepEqual(lastJson(resumed.stdout), { status: "completed" });

			const handled = await handledByLabel(directory);
			const second = new Set(handled.get("second") ?? []);
			const firstHandled = new Set(handled.get("first") ?? []);
			assert.deepEqual(
				beforeResume.processed.filter((id) => second.has(id)),
				[],
				"an event recorded before the kill was handled again",
			);
			assert.deepEqual(
				allIds.filter((id) => !second.has(id) && !firstHandled.has(id)),
				[],
				"an event was lost",
			);
			const redone = [...second].filter((id) => firstHandled.has(id));
			assert.ok(redone.length <= MAX_CONCURRENT, `only in-flight events run again, got ${redone.length}`);
			const after = records(directory, runId);
			assert.deepEqual(after.processed, allIds);
			assert.equal(after.eventRecords, EVENTS);
			assert.equal(integrity(directory), "ok");
			assert.deepEqual(
				(await readText(join(directory, "anchor.txt"))).trim().split("\n"),
				[`first ${runId}`],
				"the resumed run replays its completed anchor stage instead of running it again",
			);
		} finally {
			if (first.exitCode === null) first.kill("SIGKILL");
			await first.exited;
			removeTempDirectory(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test(
	"SIGSTOP the owner: a skewed clock cannot steal its lease; a takeover fences it with a typed error on SIGCONT (#4311)",
	async () => {
		const directory = makeTempDirectory("subscription-chaos-stop-");
		const runId = "4311c0de-0000-4000-8000-00000000000b";
		const owner = spawnProcess(
			[...COMMAND, "run", directory, runId, "owner", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
			{
				cwd: ROOT,
			},
		);
		const ownerStdout = new Response(owner.stdout).text();
		const ownerStderr = new Response(owner.stderr).text();
		try {
			await waitForHandled(directory, "owner", EVENTS / 4);
			owner.kill("SIGSTOP");
			const skewed = fixture(
				["run", directory, runId, "skewed", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
				{
					...process.env,
					NODE_OPTIONS:
						`${process.env.NODE_OPTIONS ?? ""} --import ${join(ROOT, "test/fixtures/clock-skew.mjs")}`.trim(),
					ATOMIC_TEST_CLOCK_SKEW_MS: String(6 * 60 * 60 * 1000),
				},
			);
			assert.notEqual(skewed.exitCode, 0, "a skewed clock took over a live lease");
			assert.equal((await handledByLabel(directory)).get("skewed"), undefined);

			const taken = fixture([
				"resume",
				directory,
				runId,
				"takeover",
				String(EVENTS),
				HANDLER_DELAY_MS,
				String(MAX_CONCURRENT),
			]);
			assert.equal(taken.exitCode, 0, taken.stdout.toString() + taken.stderr.toString());
			assert.deepEqual(lastJson(taken.stdout), { status: "completed" });
			owner.kill("SIGCONT");
			const ownerExit = await owner.exited;
			assert.notEqual(ownerExit, 0, `${await ownerStdout}${await ownerStderr}`);
			const failure = JSON.parse(await readText(join(directory, "failure-owner.json"))) as {
				code: string | null;
				chain: string[];
			};
			assert.equal(failure.code, "handler-failed");
			assert.ok(failure.chain.includes("JournalOwnershipError"), JSON.stringify(failure));

			const after = records(directory, runId);
			assert.deepEqual(after.processed, allIds);
			assert.equal(after.eventRecords, EVENTS);
			assert.equal(integrity(directory), "ok");
		} finally {
			if (owner.exitCode === null) {
				owner.kill("SIGCONT");
				owner.kill("SIGKILL");
			}
			await owner.exited;
			removeTempDirectory(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test(
	"concurrent writer processes on one journal each record every event exactly once (#4311)",
	async () => {
		const directory = makeTempDirectory("subscription-chaos-writers-");
		const writers = Array.from({ length: 4 }, (_, index) => ({
			runId: `4311c0de-0000-4000-8000-00000000010${index}`,
			label: `writer${index}`,
		}));
		const children = writers.map((writer) =>
			spawnProcess([...COMMAND, "run", directory, writer.runId, writer.label, String(EVENTS), "1", "8"], {
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		try {
			const outputs = children.map((child) =>
				Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
			);
			const codes = await Promise.all(children.map((child) => child.exited));
			for (const [index, code] of codes.entries()) {
				const [stdout, stderr] = await outputs[index]!;
				assert.equal(code, 0, stdout + stderr);
			}
			const handled = await handledByLabel(directory);
			for (const writer of writers) {
				assert.deepEqual([...(handled.get(writer.label) ?? [])].sort(), [...allIds].sort());
				const written = records(directory, writer.runId);
				assert.deepEqual(written.processed, allIds);
				assert.equal(written.eventRecords, EVENTS);
			}
			assert.equal(integrity(directory), "ok");
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
			removeTempDirectory(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);
