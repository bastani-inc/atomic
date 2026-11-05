import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { ForkCopyFailedError, isForkSourceBusyError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { testRunId } from "../helpers/run-id.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

/** Spawning Bun children that copy thousands of events is structural cost, not a slow test. */
const CHAOS_TEST_TIMEOUT_MS = 120_000;
const child = join(import.meta.dirname, "../fixtures/fork-chaos-child.ts");
const definition = workflow({ name: "chaos-source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
const directories: string[] = [];
const forkers: Forker[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	const reaped = await Promise.allSettled(
		forkers.splice(0).map(async (forker) => {
			if (forker.process.exitCode === null && forker.process.signalCode === null) forker.process.kill("SIGKILL");
			await forker.process.exited;
			await forker.stderr;
		}),
	);
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
	for (const outcome of reaped) if (outcome.status === "rejected") throw outcome.reason;
});

interface ChaosJournal {
	readonly path: string;
	readonly sourceId: string;
	readonly checkpoints: number;
}

async function seededJournal(seed: string, checkpoints: number): Promise<ChaosJournal> {
	const directory = makeTempDirectory("fork-chaos-");
	directories.push(directory);
	const path = join(directory, "journal.sqlite");
	const sourceId = testRunId(seed);
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		await backend.commitWorkflowRegistration({
			workflowId: sourceId,
			name: definition.name,
			inputs: {},
			status: "completed",
			createdAt: 1,
			invocationCwd: process.cwd(),
		});
		for (let index = 0; index < checkpoints; index++) {
			await backend.commitCheckpoint({
				kind: "stage",
				workflowId: sourceId,
				checkpointId: `stage:stage:step-${index}:1`,
				name: `step-${index}`,
				replayKey: `stage:step-${index}:1`,
				output: `output ${index} ${"x".repeat(200)}`,
				completedAt: 10 + index,
			});
		}
	} finally {
		await backend.close();
	}
	return { path, sourceId, checkpoints };
}

async function readAll(journal: RunJournal, runId: string): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(runId)) entries.push(entry);
	return entries;
}

function eventsHash(entries: readonly JournalEntry[]): string {
	return createHash("sha256")
		.update(JSON.stringify(entries.map((entry) => [entry.seq, entry.key ?? null, entry.event])))
		.digest("hex");
}

/** Every run besides the source is a complete fork: contiguous seed events from RunStarted to its final status. */
async function assertOnlyCompleteForks(path: string, sourceId: string, expectedCheckpoints: number): Promise<string[]> {
	const journal = await openSqlRunJournal(path);
	try {
		const forks: string[] = [];
		for (const run of await journal.listRuns()) {
			if (run.runId === sourceId) continue;
			const entries = await readAll(journal, run.runId);
			assert.equal(entries[0]?.event.type, "RunStarted", `fork ${run.runId} starts with RunStarted`);
			assert.deepEqual(
				entries.map((entry) => entry.seq),
				entries.map((_, index) => index + 1),
			);
			assert.equal(
				entries.filter((entry) => entry.event.type === "CheckpointRecorded").length,
				expectedCheckpoints,
				`fork ${run.runId} holds every copied checkpoint`,
			);
			assert.equal(entries.at(-1)?.event.type, "StatusChanged");
			const handle = entries[0]!.event.payload as { readonly forkedFrom?: { readonly runId: string } };
			assert.equal(handle.forkedFrom?.runId, sourceId);
			forks.push(run.runId);
		}
		return forks;
	} finally {
		await journal.close();
	}
}

async function sourceHash(path: string, sourceId: string): Promise<string> {
	const journal = await openSqlRunJournal(path);
	try {
		return eventsHash(await readAll(journal, sourceId));
	} finally {
		await journal.close();
	}
}

interface Forker {
	readonly process: SpawnedProcess;
	readonly lines: AsyncGenerator<Record<string, unknown>>;
	readonly stderr: Promise<string>;
}

/** A forking child process; every one is killed and reaped after its test, whatever the test's outcome. */
function spawnForker(
	journal: ChaosJournal,
	attempts: number,
	options: { readonly fromStage?: string; readonly skewMs?: number } = {},
): Forker {
	const spawned = spawnProcess(
		[
			bunExecutable(),
			child,
			journal.path,
			journal.sourceId,
			String(attempts),
			options.fromStage ?? "",
			String(options.skewMs ?? 0),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = readStreamText(spawned.stderr);
	async function* lines(): AsyncGenerator<Record<string, unknown>> {
		let buffered = "";
		for await (const chunk of decodeStream(spawned.stdout!)) {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (line.startsWith("{")) yield JSON.parse(line) as Record<string, unknown>;
				newline = buffered.indexOf("\n");
			}
		}
	}
	const forker = { process: spawned, lines: lines(), stderr };
	forkers.push(forker);
	return forker;
}

async function until(lines: AsyncGenerator<Record<string, unknown>>, event: string): Promise<Record<string, unknown>> {
	for (let next = await lines.next(); next.done !== true; next = await lines.next())
		if (next.value.event === event) return next.value;
	assert.fail(`the forker exited before ${event}`);
}

/** Ages every lease on the run past the live window, as time passing on the journal's own clock would. */
function ageLeases(path: string, runId: string): void {
	const database = new DatabaseSync(path);
	try {
		database.prepare("UPDATE wf_leases SET renewed_at = renewed_at - 600000 WHERE run_id = ?").run(runId);
	} finally {
		database.close();
	}
}

async function forkInProcess(journal: ChaosJournal) {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(journal.path), { runs: [] });
	try {
		return await forkDurableRun(backend, {
			source: "sdk",
			runId: journal.sourceId,
			carryMessages: "before",
			definition,
			cwd: process.cwd(),
		});
	} finally {
		await backend.close();
	}
}

test(
	"SIGKILL during the fork transaction leaves either no fork or a complete one, and the source unchanged (#4321)",
	async () => {
		const journal = await seededJournal("fork-chaos-kill", 1500);
		const before = await sourceHash(journal.path, journal.sourceId);
		for (const delayMs of [0, 1, 3, 8, 20]) {
			const forker = spawnForker(journal, 1);
			await until(forker.lines, "copying");
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			forker.process.kill("SIGKILL");
			assert.notEqual(await forker.process.exited, 0, "the forker was killed, not finished");
			await forker.stderr;
			ageLeases(journal.path, journal.sourceId);
		}
		const forks = await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints);
		assert.ok(forks.length <= 5);
		assert.equal(await sourceHash(journal.path, journal.sourceId), before);
		const recovered = await forkInProcess(journal);
		assert.ok(
			(await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints)).includes(recovered.runId),
		);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a SIGSTOPped fork's claim fences other forks until it expires on the journal clock, despite clock skew (#4321)",
	async () => {
		const journal = await seededJournal("fork-chaos-stop", 50);
		const before = await sourceHash(journal.path, journal.sourceId);
		const stopped = spawnForker(journal, 1, { skewMs: 3_600_000 });
		await until(stopped.lines, "claimed");
		try {
			stopped.process.kill("SIGSTOP");
			for (const skew of [-3_600_000, 0, 3_600_000]) {
				const now = Date.now.bind(Date);
				vi.spyOn(Date, "now").mockImplementation(() => now() + skew);
				const busy = await forkInProcess(journal).catch((error: Error) => error);
				vi.restoreAllMocks();
				assert.ok(isForkSourceBusyError(busy), `busy at skew ${skew}: ${String(busy)}`);
				assert.equal(busy.reason, "foreign-lease");
				assert.ok(busy.holderId?.startsWith("fork:"));
			}
			ageLeases(journal.path, journal.sourceId);
			const fenced = await forkInProcess(journal);
			assert.ok(fenced.runId);
		} finally {
			stopped.process.kill("SIGCONT");
		}
		const resumed = await until(stopped.lines, "attempt");
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		assert.equal(await stopped.process.exited, 0, await stopped.stderr);
		const forks = await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints);
		assert.equal(forks.length, 2);
		assert.equal(await sourceHash(journal.path, journal.sourceId), before);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"many concurrent forking processes each create complete forks and see only typed retryable busy errors (#4321)",
	async () => {
		const journal = await seededJournal("fork-chaos-concurrent", 100);
		const before = await sourceHash(journal.path, journal.sourceId);
		const processes = Array.from({ length: 6 }, () => spawnForker(journal, 4, { fromStage: "step-60" }));
		const outcomes = await Promise.all(
			processes.map(async (forker) => {
				const attempts: Record<string, unknown>[] = [];
				for await (const line of forker.lines) if (line.event === "attempt") attempts.push(line);
				assert.equal(await forker.process.exited, 0, await forker.stderr);
				return attempts;
			}),
		);
		const attempts = outcomes.flat();
		const successes = attempts.filter((attempt) => attempt.ok === true);
		const failures = attempts.filter((attempt) => attempt.ok !== true);
		assert.equal(successes.length, 24);
		for (const failure of failures) {
			assert.equal(failure.code, "source-busy", JSON.stringify(failure));
			assert.equal(failure.retryable, true);
		}
		const forks = await assertOnlyCompleteForks(journal.path, journal.sourceId, 60);
		assert.deepEqual(
			new Set(forks),
			new Set(successes.map((success) => success.runId as string)),
			"every success is one fork and every fork a success",
		);
		assert.equal(await sourceHash(journal.path, journal.sourceId), before);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"a full disk fails the fork as a retryable ForkCopyFailedError that leaves nothing, and a retry succeeds (#4321)",
	async () => {
		const journal = await seededJournal("fork-chaos-disk-full", 400);
		const before = await sourceHash(journal.path, journal.sourceId);
		const database = new DatabaseSync(journal.path);
		const pages = Number((database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
		database.exec(`PRAGMA max_page_count = ${pages + 2}`);
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(database), { runs: [] });
		try {
			const request = {
				source: "sdk" as const,
				runId: journal.sourceId,
				carryMessages: "before" as const,
				definition,
				cwd: process.cwd(),
			};
			const full = await forkDurableRun(backend, request).catch((error: Error) => error);
			assert.ok(full instanceof ForkCopyFailedError, String(full));
			assert.equal(full.phase, "journal");
			assert.equal(full.retryable, true);
			const causes: string[] = [];
			for (let cause = full.cause; cause instanceof Error; cause = cause.cause) causes.push(cause.message);
			assert.ok(
				causes.some((message) => /full/i.test(message)),
				causes.join(" <- "),
			);
			assert.equal(await backend.journal.getRun(full.forkRunId), undefined);
			assert.deepEqual(await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints), []);
			database.exec("PRAGMA max_page_count = 1073741823");
			const recovered = await forkDurableRun(backend, request);
			assert.deepEqual(await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints), [
				recovered.runId,
			]);
		} finally {
			await backend.close();
			database.close();
		}
		assert.equal(database.isOpen, false, "the caller-owned connection is closed before removing its directory");
		assert.equal(await sourceHash(journal.path, journal.sourceId), before);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"a writer stalled holding the database lock delays a fork without failing or splitting it (#4321)",
	async () => {
		const journal = await seededJournal("fork-chaos-stalled-writer", 200);
		const holder = await holdSqliteWriteLock(journal.path);
		let released = false;
		const release = async () => {
			if (released) return;
			released = true;
			await holder.release();
		};
		const fork = forkInProcess(journal);
		let settled = false;
		void fork.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			assert.equal(settled, false, "the fork waits for the stalled writer");
			const reader = new DatabaseSync(journal.path, { readOnly: true });
			try {
				assert.deepEqual(
					reader
						.prepare("SELECT run_id FROM wf_runs")
						.all()
						.map((row) => row.run_id),
					[journal.sourceId],
				);
			} finally {
				reader.close();
			}
		} finally {
			await release();
		}
		const forked = await fork;
		assert.deepEqual(await assertOnlyCompleteForks(journal.path, journal.sourceId, journal.checkpoints), [
			forked.runId,
		]);
	},
	CHAOS_TEST_TIMEOUT_MS,
);
