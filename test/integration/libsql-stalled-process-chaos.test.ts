import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { type FakeLibsqlServer, startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import { createProcessSuspender } from "../helpers/process-suspension.js";
import { bunExecutable, readStreamText, type SpawnedProcess, sleep, spawnProcess } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const WRITER = fileURLToPath(new URL("../fixtures/libsql-stalled-journal-writer.ts", import.meta.url));
/**
 * How long the server keeps an idle stream; sqld keeps one 10 seconds. Scaled down so the test stays short, yet long
 * enough that a loaded machine's ordinary gaps between one transaction's requests never reach it.
 */
const STREAM_TTL_MS = 2_000;
/** How long the writer stays stopped mid-transaction: well past the stream's expiry, as in #4383's 15-second stop. */
const STALL_MS = 3 * STREAM_TTL_MS;
const ROUNDS = 3;
/** A Bun child that loads the journal from source, a stall, and a retry backoff. */
const CHAOS_TIMEOUT_MS = 60_000;

/** Reads the child's stdout one line at a time. */
function lineReader(child: SpawnedProcess): () => Promise<string> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	return async () => {
		while (!buffered.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(`writer exited early: ${buffered}${await readStreamText(child.stderr)}`);
			buffered += decoder.decode(next.value, { stream: true });
		}
		const end = buffered.indexOf("\n");
		const line = buffered.slice(0, end).trim();
		buffered = buffered.slice(end + 1);
		return line;
	};
}

function rows(fake: FakeLibsqlServer): { seq: number; key: string | null; type: string }[] {
	return fake.database
		.prepare("SELECT seq, key, type FROM wf_events WHERE run_id = 'root' ORDER BY seq")
		.all()
		.map((row) => ({ seq: Number(row.seq), key: row.key as string | null, type: String(row.type) }));
}

interface WriterReport {
	readonly outcomes?: string[];
	readonly failure?: { name: string; code?: string; message: string };
	readonly warnings: { name: string; code?: string; outcome?: string }[];
}

/**
 * Starts the writer in `mode` and stops it, with SIGSTOP, at the moment the server reaches the point `stopAt` waits for
 * in its first append, for {@link STALL_MS}, well past the server's stream expiry; then lets it go on. Resolves with
 * the writer's report once it exits cleanly, and checks that every event is written once, in order, with no gap.
 */
async function stallWriter(
	fake: FakeLibsqlServer,
	mode: "transaction" | "one-request",
	stopAt: (stop: () => Promise<void>) => void,
): Promise<WriterReport> {
	const suspender = await createProcessSuspender();
	const child = spawnProcess([bunExecutable(), WRITER, fake.url, String(ROUNDS), mode], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const pid = child.pid!;
	const reached = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	try {
		const readLine = lineReader(child);
		assert.equal(await readLine(), "ready");
		// The test stops the writer outside the server's handler, so a failed check fails the test instead of that one
		// request; the server answers once the writer is stopped.
		stopAt(() => {
			reached.resolve();
			return stopped.promise;
		});
		child.stdin!.write("go\n");
		// A writer that ends before it reaches the stop fails the test with its report, instead of a timeout.
		const first = await Promise.race([
			reached.promise.then(() => "reached" as const),
			child.exited.then(() => "exited" as const),
		]);
		if (first === "exited") assert.fail(`the writer exited before it was stopped: ${await readLine()}`);
		await suspender.suspend(pid);
		assert.equal(await suspender.isSuspended(pid), true, "the writer is stopped");
		stopped.resolve();
		await sleep(STALL_MS);
		await suspender.resume(pid);
		const report = JSON.parse(await readLine()) as WriterReport;
		assert.equal(await child.exited, 0, JSON.stringify(report.failure));
		assert.deepEqual(
			report.outcomes,
			Array.from({ length: 2 * ROUNDS }, () => "appended"),
		);
		const written = rows(fake);
		assert.deepEqual(
			written.map((row) => row.seq),
			Array.from({ length: 2 * ROUNDS }, (_, index) => index + 1),
			"each event once, in order, with no gap",
		);
		assert.deepEqual(
			written.map((row) => [row.key, row.type]),
			Array.from({ length: ROUNDS }, (_, round) => [
				[`stage:${round}`, "CheckpointRecorded"],
				[null, "StatusChanged"],
			]).flat(),
		);
		return report;
	} finally {
		stopped.resolve();
		if (child.exitCode === null && child.signalCode === null) {
			await suspender.resume(pid).catch(() => undefined);
			child.kill("SIGKILL");
			await child.exited;
		}
		await suspender.close();
	}
}

test(
	"a journal writer stopped mid-transaction past the server's stream expiry resumes and writes each event once (#4383)",
	async () => {
		const fake = await startFakeLibsqlServer({ streamTtlMs: STREAM_TTL_MS });
		try {
			// Appends that name the sequence they expect stay in an interactive transaction. The writer is stopped once
			// its first one has opened its transaction on the server, which then expires the stream: the writer's next
			// statement in that transaction finds it gone, and the transaction runs again.
			const report = await stallWriter(fake, "transaction", (stop) =>
				fake.onOpenTransaction(() => {
					fake.onOpenTransaction(undefined);
					return stop();
				}),
			);
			assert.equal(
				fake.expiredStatements,
				1,
				`the stall ended the writer's transaction on the server; the writer saw ${JSON.stringify(report.warnings)} after requests ${JSON.stringify(fake.pipelines.slice(-6))}`,
			);
			assert.deepEqual(report.warnings, [
				{ name: "StorageTransientError", code: "stream-expired", outcome: "not-applied" },
			]);
		} finally {
			await fake.close();
		}
	},
	CHAOS_TIMEOUT_MS,
);

test(
	"a journal writer stopped between sending a one-request append and its answer, past the server's stream expiry, resumes and writes each event once (#4768)",
	async () => {
		const fake = await startFakeLibsqlServer({ streamTtlMs: STREAM_TTL_MS });
		try {
			// An append without an expected sequence is one request: the server runs it, and the writer is stopped before
			// the answer is sent. The answer waits for it in the connection, so the resumed writer reads that the append
			// committed and goes on; nothing is sent again, and nothing ran on an expired stream.
			const report = await stallWriter(fake, "one-request", (stop) =>
				fake.onBatch(() => {
					fake.onBatch(undefined);
					return stop();
				}),
			);
			assert.equal(
				fake.expiredStatements,
				0,
				`a statement met an expired stream; the writer saw ${JSON.stringify(report.warnings)} after requests ${JSON.stringify(fake.pipelines.slice(-6))}`,
			);
			assert.deepEqual(report.warnings, []);
		} finally {
			await fake.close();
		}
	},
	CHAOS_TIMEOUT_MS,
);
