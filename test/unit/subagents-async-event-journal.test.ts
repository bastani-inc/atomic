import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createChildEventJournal, sanitizeChildEvent } from "../../packages/subagents/src/runs/background/async-event-journal.js";
import { runPiStreaming } from "../../packages/subagents/src/runs/background/subagent-runner-streaming.js";
import { appendJsonl } from "../../packages/subagents/src/shared/artifacts.js";
import type { JsonlWriteStream } from "../../packages/subagents/src/shared/jsonl-writer.js";
import {
	eventWriterHydrationCacheSizeForTests,
	resetEventWriterHydrationCacheForTests,
} from "../../packages/subagents/src/shared/event-jsonl-writer.js";

const tempRoots: string[] = [];
afterEach(() => {
	resetEventWriterHydrationCacheForTests();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("child event persistence strips cumulative delta snapshots and retains incremental metadata", () => {
	const event = sanitizeChildEvent({
		type: "message_update",
		message: { content: "the cumulative assistant message" },
		assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "x", partial: { content: "cumulative" } },
	});
	assert.equal("message" in event, false);
	const delta = event.assistantMessageEvent as Record<string, unknown>;
	assert.equal("partial" in delta, false);
	assert.deepEqual(delta, { type: "text_delta", contentIndex: 2, delta: "x" });
	assert.equal("content" in (sanitizeChildEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "full" } }).assistantMessageEvent as Record<string, unknown>), false);
	assert.equal("partialResult" in sanitizeChildEvent({ type: "tool_execution_update", partialResult: { content: "cumulative" } }), false);
	assert.equal("message" in sanitizeChildEvent({ type: "message_start", message: { content: "FINAL" } }), false);
});

test("child event journal bounds telemetry while retaining one full final message and drains", async () => {
	const chunks: string[] = [];
	let ended = false;
	let finishEnd: (() => void) | undefined;
	const stream: JsonlWriteStream = {
		write(chunk) { chunks.push(chunk); return true; },
		once() { return this; },
		end(callback) { finishEnd = () => { ended = true; callback?.(); }; },
	};
	const source = { pause() {}, resume() {} };
	const journal = createChildEventJournal("events.jsonl", source, { runId: "run", agent: "worker" }, {
		maxTelemetryBytes: 900,
		createWriteStream: () => stream,
		now: () => 1,
	});
	for (let i = 0; i < 100; i++) {
		const cumulative = "x".repeat(i + 1);
		journal.append({
			type: "message_update",
			message: { content: cumulative },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: { content: cumulative } },
		});
	}
	journal.append({ type: "turn_start" });
	journal.append({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100) }] } });
	for (const type of ["model_fallback_start", "model_fallback_end", "agent_continue_error", "model_changed", "session_info_changed", "thinking_level_changed"]) {
		journal.append({ type, detail: "must survive" });
	}
	const closing = journal.close();
	assert.equal(ended, false, "close must wait for the stream drain callback");
	const concurrentClose = journal.close();
	assert.equal(concurrentClose, closing, "repeated close calls share the in-progress drain");
	assert.ok(finishEnd);
	finishEnd();
	await closing;
	assert.equal(ended, true);

	const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(records.filter((record) => record.type === "subagent.child.telemetry_truncated").length, 1);
	const updates = records.filter((record) => record.type === "message_update");
	assert.ok(updates.length < 100);
	assert.ok(updates.every((record) => !("message" in record)));
	assert.ok(updates.every((record) => !("partial" in (record.assistantMessageEvent as Record<string, unknown>))));
	assert.equal(records.filter((record) => record.type === "turn_start").length, 1, "lifecycle records bypass the telemetry cap");
	const finals = records.filter((record) => record.type === "message_end");
	assert.equal(finals.length, 1);
	assert.match(JSON.stringify(finals[0]), /xxxxxxxxxx/);
	for (const type of ["model_fallback_start", "model_fallback_end", "agent_continue_error", "model_changed", "session_info_changed", "thinking_level_changed"]) {
		assert.equal(records.filter((record) => record.type === type).length, 1);
	}
	assert.ok(Buffer.byteLength(chunks.join("")) < 4_000, "bounded delta telemetry must not grow with cumulative snapshots");
});

test("terminal update metadata does not duplicate the final assistant message", async () => {
	const chunks: string[] = [];
	const stream: JsonlWriteStream = {
		write(chunk) { chunks.push(chunk); return true; },
		once() { return this; },
		end(callback) { callback?.(); },
	};
	const journal = createChildEventJournal("terminal-final.jsonl", { pause() {}, resume() {} }, { runId: "run", agent: "worker" }, {
		createWriteStream: () => stream,
		now: () => 1,
	});
	journal.append({
		type: "message_update",
		message: { role: "assistant", content: "FINAL-CONTENT" },
		assistantMessageEvent: {
			type: "done",
			message: { role: "assistant", content: "FINAL-CONTENT" },
			stopReason: "stop",
		},
	});
	journal.append({ type: "message_end", message: { role: "assistant", content: "FINAL-CONTENT" } });
	await journal.close();

	const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	const terminal = records.find((record) => record.type === "message_update");
	assert.deepEqual(terminal?.assistantMessageEvent, { type: "done", stopReason: "stop" });
	assert.equal(records.filter((record) => JSON.stringify(record).includes("FINAL-CONTENT")).length, 1);
	assert.equal(records.filter((record) => record.type === "message_end").length, 1);
});

test("message_start never duplicates finalized content retained by message_end", async () => {
	const chunks: string[] = [];
	const stream: JsonlWriteStream = { write(chunk) { chunks.push(chunk); return true; }, once() { return this; }, end(callback) { callback?.(); } };
	const journal = createChildEventJournal("start-final.jsonl", { pause() {}, resume() {} }, { runId: "run", agent: "worker" }, {
		createWriteStream: () => stream,
		now: () => 1,
	});
	journal.append({ type: "message_start", message: { role: "assistant", content: "FINAL" } });
	journal.append({ type: "message_end", message: { role: "assistant", content: "FINAL" } });
	await journal.close();
	const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(records.filter((record) => JSON.stringify(record).includes("FINAL")).length, 1);
	assert.equal("message" in records.find((record) => record.type === "message_start")!, false);
});


test("run-level telemetry cap is shared across journals and nested terminal updates bypass it", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-shared-event-budget-"));
	tempRoots.push(root);
	const eventsPath = path.join(root, "events.jsonl");
	const source = { pause() {}, resume() {} };
	const first = createChildEventJournal(eventsPath, source, { runId: "run", stepIndex: 0, agent: "one" }, { maxTelemetryBytes: 500, now: () => 1 });
	const second = createChildEventJournal(eventsPath, source, { runId: "run", stepIndex: 1, agent: "two" }, { maxTelemetryBytes: 500, now: () => 1 });
	for (let i = 0; i < 20; i++) {
		first.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(80) } });
		second.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y".repeat(80) } });
	}
	appendJsonl(eventsPath, JSON.stringify({ type: "subagent.control", sequence: 1 }));
	first.append({ type: "message_update", assistantMessageEvent: { type: "done", content: "terminal done" } });
	second.append({ type: "message_update", assistantMessageEvent: { type: "error", error: "terminal error" } });
	await Promise.all([first.close(), second.close()]);
	const retry = createChildEventJournal(eventsPath, source, { runId: "run", stepIndex: 1, agent: "two" }, { maxTelemetryBytes: 500, now: () => 2 });
	retry.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "retry telemetry" } });
	retry.append({ type: "message_end", message: { role: "assistant", content: "retry final" } });
	for (const type of ["model_fallback_start", "model_fallback_end", "agent_continue_error", "model_changed", "session_info_changed", "thinking_level_changed"]) {
		retry.append({ type, detail: "after cap" });
	}
	await retry.close();
	const records = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(records.filter((record) => record.type === "subagent.child.telemetry_truncated").length, 1);
	assert.equal(records.filter((record) => record.type === "subagent.control").length, 1, "critical writes share the open writer");
	assert.equal(records.filter((record) => JSON.stringify(record).includes("retry telemetry")).length, 0);
	assert.equal(records.filter((record) => JSON.stringify(record).includes("retry final")).length, 1);
	const nestedTypes = records
		.filter((record) => record.type === "message_update")
		.map((record) => (record.assistantMessageEvent as Record<string, unknown>).type);
	assert.ok(nestedTypes.includes("done"));
	assert.ok(nestedTypes.includes("error"));
	for (const type of ["model_fallback_start", "model_fallback_end", "agent_continue_error", "model_changed", "session_info_changed", "thinking_level_changed"]) {
		assert.equal(records.filter((record) => record.type === type).length, 1, `${type} must bypass the telemetry cap`);
	}
	assert.ok(Buffer.byteLength(fs.readFileSync(eventsPath)) < 2_000, "parallel journals share one bounded telemetry budget");
});

test("journal acquired during delayed close hands off without losing or reordering lines", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-event-handoff-"));
	tempRoots.push(root);
	const eventsPath = path.join(root, "events.jsonl");
	const writes: string[] = [];
	let releaseFirstClose: (() => void) | undefined;
	let streamCount = 0;
	let secondEnded = false;
	const createWriteStream = (): JsonlWriteStream => {
		const index = streamCount++;
		return {
			write(chunk) { writes.push(chunk); return true; },
			once() { return this; },
			end(callback) {
				if (index === 0) releaseFirstClose = () => callback?.();
				else { secondEnded = true; callback?.(); }
			},
		};
	};
	const source = { pause() {}, resume() {} };
	const first = createChildEventJournal(eventsPath, source, { runId: "run", stepIndex: 0, agent: "one" }, { createWriteStream, now: () => 1 });
	first.append({ type: "turn_start", sequence: 1 });
	const firstClosing = first.close();
	const second = createChildEventJournal(eventsPath, source, { runId: "run", stepIndex: 1, agent: "two" }, { createWriteStream, now: () => 2 });
	second.append({ type: "turn_start", sequence: 2 });
	assert.equal(streamCount, 1, "handoff waits for the closing stream instead of leasing it or racing a new handle");
	assert.deepEqual(writes.map((line) => JSON.parse(line).sequence), [1]);
	assert.ok(releaseFirstClose);
	releaseFirstClose();
	await firstClosing;
	await second.close();
	assert.equal(secondEnded, true, "handoff stream must be ended by the deferred lease");
	assert.equal(streamCount, 2);
	assert.deepEqual(writes.map((line) => JSON.parse(line).sequence), [1, 2]);
});


test("writer reacquisition detects externally appended truncation markers and resets after shrink", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-event-hydration-"));
	tempRoots.push(root);
	const eventsPath = path.join(root, "events.jsonl");
	fs.writeFileSync(eventsPath, `${JSON.stringify({ type: "existing" })}\n`);
	const source = { pause() {}, resume() {} };
	const first = createChildEventJournal(eventsPath, source, { runId: "run", agent: "one" }, { maxTelemetryBytes: 10_000, now: () => 1 });
	first.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } });
	await first.close();
	fs.appendFileSync(eventsPath, `${JSON.stringify({ type: "subagent.child.telemetry_truncated" })}\n`);
	const second = createChildEventJournal(eventsPath, source, { runId: "run", agent: "two" }, { maxTelemetryBytes: 10_000, now: () => 2 });
	second.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "blocked-after-external-marker" } });
	await second.close();
	assert.doesNotMatch(fs.readFileSync(eventsPath, "utf-8"), /blocked-after-external-marker/);

	fs.writeFileSync(eventsPath, "", "utf-8");
	const afterShrink = createChildEventJournal(eventsPath, source, { runId: "run", agent: "three" }, { maxTelemetryBytes: 10_000, now: () => 3 });
	afterShrink.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "accepted-after-shrink" } });
	await afterShrink.close();
	assert.match(fs.readFileSync(eventsPath, "utf-8"), /accepted-after-shrink/);
});

test("hydration detects same-inode rewrites and truncate-then-grow boundary changes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-event-rewrite-"));
	tempRoots.push(root);
	const eventsPath = path.join(root, "events.jsonl");
	const marker = '{"type":"subagent.child.telemetry_truncated"}\n';
	const source = { pause() {}, resume() {} };
	fs.writeFileSync(eventsPath, "x".repeat(Buffer.byteLength(marker)));
	await createChildEventJournal(eventsPath, source, { runId: "run", agent: "seed" }).close();
	fs.writeFileSync(eventsPath, marker.padEnd(Buffer.byteLength(marker), " "));
	const equalRewrite = createChildEventJournal(eventsPath, source, { runId: "run", agent: "equal" }, { maxTelemetryBytes: 10_000 });
	equalRewrite.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "blocked-equal-rewrite" } });
	await equalRewrite.close();
	assert.doesNotMatch(fs.readFileSync(eventsPath, "utf-8"), /blocked-equal-rewrite/);

	const markerStat = fs.statSync(eventsPath);
	fs.writeFileSync(eventsPath, "y".repeat(markerStat.size));
	fs.utimesSync(eventsPath, markerStat.atime, markerStat.mtime);
	const markerRemoved = createChildEventJournal(eventsPath, source, { runId: "run", agent: "marker-removed" }, { maxTelemetryBytes: 10_000 });
	markerRemoved.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "accepted-after-same-size-rewrite" } });
	await markerRemoved.close();
	assert.match(fs.readFileSync(eventsPath, "utf-8"), /accepted-after-same-size-rewrite/);

	fs.writeFileSync(eventsPath, "a".repeat(600));
	await createChildEventJournal(eventsPath, source, { runId: "run", agent: "reset" }).close();
	fs.writeFileSync(eventsPath, `${marker}${"b".repeat(700)}`);
	const regrown = createChildEventJournal(eventsPath, source, { runId: "run", agent: "regrown" }, { maxTelemetryBytes: 10_000 });
	regrown.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "blocked-regrown" } });
	await regrown.close();
	assert.doesNotMatch(fs.readFileSync(eventsPath, "utf-8"), /blocked-regrown/);
});

test("hydration cache is bounded across unique journal paths", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-event-cache-bound-"));
	tempRoots.push(root);
	const source = { pause() {}, resume() {} };
	for (let index = 0; index < 520; index += 1) {
		const file = path.join(root, `${index}.jsonl`);
		fs.writeFileSync(file, "");
		const journal = createChildEventJournal(file, source, { runId: `run-${index}`, agent: "worker" });
		await journal.close();
	}
	assert.equal(eventWriterHydrationCacheSizeForTests(), 512);
});
test("sanitized delta persistence grows linearly below the cap", async () => {
	const persistedSize = async (count: number, file: string): Promise<number> => {
		const chunks: string[] = [];
		const stream: JsonlWriteStream = { write(chunk) { chunks.push(chunk); return true; }, once() { return this; }, end(callback) { callback?.(); } };
		const journal = createChildEventJournal(file, { pause() {}, resume() {} }, { runId: "linear", agent: "worker" }, {
			maxTelemetryBytes: 10_000_000, createWriteStream: () => stream, now: () => 1,
		});
		for (let i = 0; i < count; i++) journal.append({ type: "message_update", message: { content: "x".repeat(i + 1) }, assistantMessageEvent: { type: "text_delta", delta: "x", partial: { content: "x".repeat(i + 1) } } });
		await journal.close();
		return Buffer.byteLength(chunks.join(""));
	};
	const one = await persistedSize(100, "linear-100.jsonl");
	const two = await persistedSize(200, "linear-200.jsonl");
	assert.ok(two / one > 1.9 && two / one < 2.1, `expected ~2x growth, got ${two / one}`);
});
test("streaming runner persists bounded valid JSONL and drains before later control events", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-event-journal-e2e-"));
	tempRoots.push(root);
	const fakeCli = path.join(root, "fake-cli.ts");
	const eventsPath = path.join(root, "events.jsonl");
	const outputPath = path.join(root, "output.log");
	fs.writeFileSync(fakeCli, `
for (let i = 0; i < 3000; i++) {
  const text = "x".repeat(i + 1);
  console.log(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: { content: text } } }));
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL-CONTENT" }], stopReason: "stop", usage: {} } }));
`);
	const result = await runPiStreaming([], root, outputPath, undefined, undefined, fakeCli, undefined, undefined, {
		eventsPath, runId: "e2e", stepIndex: 0, agent: "worker",
	});
	assert.equal(result.exitCode, 0);
	fs.appendFileSync(eventsPath, `${JSON.stringify({ type: "subagent.control", runId: "e2e" })}\n`);
	const text = fs.readFileSync(eventsPath, "utf-8");
	assert.ok(Buffer.byteLength(text) < 600 * 1024);
	const records = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(records.filter((record) => record.type === "message_end").length, 1);
	assert.equal(records.filter((record) => JSON.stringify(record).includes("FINAL-CONTENT")).length, 1);
	assert.equal(records.at(-1)?.type, "subagent.control");
	assert.ok(records.filter((record) => record.type === "message_update").every((record) => !("message" in record)));
});

test("spawn failure keeps its diagnostic when close races journal drain", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-spawn-error-race-"));
	tempRoots.push(root);
	const result = await runPiStreaming([], root, path.join(root, "output.txt"), { PATH: "" }, path.join(root, "missing-package"), path.join(root, "missing-cli.ts"));
	assert.equal(result.exitCode === 0, false);
	assert.match(result.error ?? "", /failed to spawn subagent runtime/);
	assert.match(result.error ?? "", /runtime executable was not found/);
});

test("raw child stdout and stderr share the bounded telemetry budget", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-raw-event-budget-"));
	tempRoots.push(root);
	const fakeCli = path.join(root, "fake-cli.ts");
	const eventsPath = path.join(root, "events.jsonl");
	fs.writeFileSync(fakeCli, `for (let i = 0; i < 1500; i++) console.error("e".repeat(1024));\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "FINAL" } }));`);
	const result = await runPiStreaming([], root, path.join(root, "output.log"), undefined, undefined, fakeCli, undefined, undefined, {
		eventsPath, runId: "raw", stepIndex: 0, agent: "worker",
	});
	assert.equal(result.exitCode, 0);
	const text = fs.readFileSync(eventsPath, "utf-8");
	assert.ok(Buffer.byteLength(text) < 600 * 1024, `raw telemetry exceeded bound: ${Buffer.byteLength(text)}`);
	const records = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.equal(records.filter((record) => record.type === "subagent.child.telemetry_truncated").length, 1);
	assert.equal(records.filter((record) => record.type === "message_end").length, 1);
});

test("asynchronous event stream failure is non-fatal and releases paused sources", async () => {
	let pauseCalls = 0;
	let resumeCalls = 0;
	let errorListener: ((error: Error) => void) | undefined;
	let streamCount = 0;
	let healthyEnded = false;
	const createWriteStream = (): JsonlWriteStream => {
		const failing = streamCount++ === 0;
		return {
			write() { return !failing; },
			on(event, listener) { if (event === "error" && failing) errorListener = listener; return this; },
			once() { return this; },
			end(callback) { if (!failing) healthyEnded = true; callback?.(); },
		};
	};
	const source = { pause() { pauseCalls += 1; }, resume() { resumeCalls += 1; } };
	const first = createChildEventJournal("controlled-error.jsonl", source, { runId: "run", agent: "one" }, { createWriteStream });
	first.append({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "blocked" } });
	assert.equal(pauseCalls, 1);
	assert.ok(errorListener);
	errorListener(new Error("controlled stream failure"));
	assert.equal(resumeCalls, 1, "stream failure must release backpressured sources");
	await first.close();
	const second = createChildEventJournal("controlled-error.jsonl", source, { runId: "run", agent: "two" }, { createWriteStream });
	second.append({ type: "turn_start" });
	await second.close();
	assert.equal(streamCount, 2, "failed writer must release the path for reacquisition");
	assert.equal(healthyEnded, true, "replacement writer still closes normally");
});
