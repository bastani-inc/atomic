import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { DistributedTimeoutError, isDistributedTimeoutError } from "../distributed/harness/errors.mjs";
import {
	Host,
	readJsonLines,
	readJsonLinesFile,
	readWriterEvidence,
	UndoScope,
} from "../distributed/harness/remote.mjs";
import { exerciseProfile } from "../distributed/harness/suites.mjs";

const posixOnly = test.skipIf(process.platform === "win32");

let scratch: string;
let originalPath: string | undefined;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "adt-undo-"));
	writeFileSync(join(scratch, "ssh"), "#!/bin/sh\nexec bash -s\n");
	chmodSync(join(scratch, "ssh"), 0o755);
	originalPath = process.env.PATH;
	process.env.PATH = `${scratch}${delimiter}${originalPath ?? ""}`;
});
afterEach(() => {
	process.env.PATH = originalPath;
	rmSync(scratch, { recursive: true, force: true });
});

const hostWith = (signal?: AbortSignal) =>
	new Host({
		context: { secrets: new Set() },
		name: "node-1",
		ip: "10.60.0.4",
		user: "adt",
		key: "unused",
		knownHosts: "unused",
		...(signal === undefined ? {} : { signal }),
	});

posixOnly(
	"a cancelled run still reverts its fault: revert and cleanup run under their own signal (#4331)",
	async () => {
		const controller = new AbortController();
		const reason = new DOMException("cancelled by SIGINT", "AbortError");
		const scope = new UndoScope({ signal: controller.signal });
		const host = scope.bind(hostWith(controller.signal));
		const marker = (name: string) => join(scratch, name);
		const faults: Parameters<typeof exerciseProfile>[0]["faults"] = [];
		await assert.rejects(
			exerciseProfile(
				{
					profiles: ["partition"],
					faults,
					started: performance.now(),
					log: () => {},
					signal: controller.signal,
					undo: (step) => scope.undo(step),
				},
				{
					profile: "partition",
					target: "node-1",
					parameters: {},
					apply: async (fault) => {
						fault.applied = true;
						controller.abort(reason);
						await host.run(`touch ${marker("applied")}`, { operation: "apply" });
					},
					revert: async () => void (await host.run(`touch ${marker("reverted")}`, { operation: "revert" })),
					cleanup: async () => void (await host.run(`touch ${marker("cleaned")}`, { operation: "cleanup" })),
				},
			),
			(error) => error === reason,
		);
		assert.equal(existsSync(marker("applied")), false, "the cancelled scenario command never starts");
		assert.equal(existsSync(marker("reverted")), true, "the revert command ran although the run was cancelled");
		assert.equal(existsSync(marker("cleaned")), true, "the cleanup command ran although the run was cancelled");
		assert.equal(faults[0]?.error, undefined, "a cancellation is not recorded as a failed fault");
	},
);

posixOnly("commands outside an undo step still honour the run's cancellation (#4331)", async () => {
	const controller = new AbortController();
	const scope = new UndoScope({ signal: controller.signal });
	const host = scope.bind(hostWith(controller.signal));
	const reason = new DOMException("stop", "AbortError");
	controller.abort(reason);
	await assert.rejects(host.run("true", { operation: "after cancel" }), (error) => error === reason);
	await scope.undo(async () => void (await host.run("true", { operation: "inside undo" })));
	await assert.rejects(host.run("true", { operation: "after undo" }), (error) => error === reason);
});

test("an undo step is bounded: when its budget passes, the step's signal aborts with a typed timeout (#4331)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	try {
		const scope = new UndoScope({ signal: new AbortController().signal, budgetMs: 25 });
		await vi.advanceTimersByTimeAsync(1000);
		const undo = scope.undo(
			() =>
				new Promise<unknown>((resolve) => {
					const signal = scope.signal as AbortSignal;
					signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
				}),
		);
		await vi.advanceTimersByTimeAsync(25);
		const seen = await undo;
		assert.ok(isDistributedTimeoutError(seen));
		assert.equal((seen as { code: string }).code, "timeout");
		const fields = (seen as { fields: object }).fields;
		assert.equal(Reflect.get(fields, "phase"), "fault undo");
		assert.equal(Reflect.get(fields, "timeoutMs"), 25);
		assert.equal(Reflect.get(fields, "elapsedMs"), 25);
	} finally {
		vi.useRealTimers();
	}
});

test("a finished undo step leaves no timer behind, so its budget cannot abort anything later (#4331)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	try {
		const scope = new UndoScope({ signal: new AbortController().signal, budgetMs: 25 });
		let stepSignal: AbortSignal | undefined;
		await scope.undo(async () => {
			stepSignal = scope.signal;
		});
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(60_000);
		assert.equal(stepSignal?.aborted, false);
	} finally {
		vi.useRealTimers();
	}
});

test("an undo step's signal is independent of the run signal and restored afterwards, even when the step fails (#4331)", async () => {
	const run = new AbortController();
	const scope = new UndoScope({ signal: run.signal });
	assert.equal(scope.signal, run.signal);
	run.abort(new Error("run cancelled"));
	await assert.rejects(
		scope.undo(async () => {
			assert.notEqual(scope.signal, run.signal);
			assert.equal(scope.signal?.aborted, false);
			throw new Error("revert failed");
		}),
		{ message: "revert failed" },
	);
	assert.equal(scope.signal, run.signal);
});

test("a scope without a run signal still gives undo steps a bounded signal (#4331)", async () => {
	const scope = new UndoScope({});
	assert.equal(scope.signal, undefined);
	await scope.undo(async () => assert.equal(scope.signal?.aborted, false));
	assert.equal(scope.signal, undefined);
});

posixOnly("a missing acknowledgement file is absent evidence, not an empty history (#4331)", async () => {
	const host = hostWith();
	const present = join(scratch, "w1.jsonl");
	writeFileSync(present, '{"event":"ack","index":0}\nnot json\n{"event":"done"}\n');
	assert.deepEqual(await readJsonLinesFile(host, present), [{ event: "ack", index: 0 }, { event: "done" }]);
	assert.equal(await readJsonLinesFile(host, join(scratch, "missing.jsonl")), undefined);
	assert.deepEqual(
		await readJsonLines(host, join(scratch, "missing.jsonl")),
		[],
		"waiting for startup allows no file yet",
	);
	writeFileSync(join(scratch, "empty.jsonl"), "");
	assert.deepEqual(await readJsonLinesFile(host, join(scratch, "empty.jsonl")), [], "an empty file exists");
});

posixOnly(
	"an acknowledgement path that exists but cannot be read fails instead of reading as empty (#4331)",
	async () => {
		const host = hostWith();
		const unreadable = join(scratch, "unreadable.jsonl");
		mkdirSync(unreadable);
		await assert.rejects(readJsonLinesFile(host, unreadable), (error: unknown) => {
			assert.equal(Reflect.get(error as object, "name"), "DistributedCommandError");
			assert.equal(Reflect.get(error as object, "code"), "command-failed");
			assert.equal(Reflect.get(Reflect.get(error as object, "fields"), "operation"), `node-1: read ${unreadable}`);
			return true;
		});
		await assert.rejects(readJsonLines(host, unreadable), {
			name: "DistributedCommandError",
			code: "command-failed",
		});
		await assert.rejects(readWriterEvidence([{ holder: "w1", host, acks: unreadable }]), {
			name: "DistributedCommandError",
		});
	},
);

posixOnly(
	"final evidence lists every writer whose file is missing and keeps the records it did read (#4331)",
	async () => {
		const host = hostWith();
		writeFileSync(join(scratch, "w1.jsonl"), '{"event":"ack","index":0}\n');
		writeFileSync(join(scratch, "w3.jsonl"), '{"event":"ack","index":1}\n');
		const evidence = await readWriterEvidence([
			{ holder: "w1", host, acks: join(scratch, "w1.jsonl") },
			{ holder: "w2", host, acks: join(scratch, "w2.jsonl") },
			{ holder: "w3", host, acks: join(scratch, "w3.jsonl") },
		]);
		assert.deepEqual(evidence.records, [
			{ event: "ack", index: 0 },
			{ event: "ack", index: 1 },
		]);
		assert.deepEqual(evidence.missing, [{ holder: "w2", host: "node-1", path: join(scratch, "w2.jsonl") }]);
	},
);

test("the default undo budget is ninety minutes, covering sequential VM operations (#4331)", async () => {
	vi.useFakeTimers();
	try {
		const scope = new UndoScope({});
		let undoSignal: AbortSignal | undefined;
		const undo = scope.undo(
			() =>
				new Promise<unknown>((resolve) => {
					undoSignal = scope.signal;
					undoSignal?.addEventListener("abort", () => resolve(undoSignal?.reason), { once: true });
				}),
		);
		await vi.advanceTimersByTimeAsync(90 * 60_000 - 1);
		assert.equal(undoSignal?.aborted, false);
		await vi.advanceTimersByTimeAsync(1);
		const error = await undo;
		assert.ok(isDistributedTimeoutError(error));
		assert.ok(error instanceof DistributedTimeoutError);
		assert.equal(error.fields.timeoutMs, 90 * 60_000);
		assert.equal(scope.signal, undefined);
	} finally {
		vi.useRealTimers();
	}
});
