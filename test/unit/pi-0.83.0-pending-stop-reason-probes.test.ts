/**
 * P4 probe — the inherited `pending` streaming stop reason (upstream
 * `f9a49869`).
 *
 * `pending` is not a terminal reason a provider delivers: pi-ai raises an error
 * when a stream *ends* on it. It is the reason every in-flight partial carries,
 * so it crosses Atomic's surfaces on every single turn — `message_start` and
 * each `message_update` carry `stopReason: "pending"`, and only `message_end`
 * carries the terminal reason. The first test below measures that rather than
 * assuming it, so the rest of the file cannot quietly stop covering the real
 * shape.
 *
 * Four consumers must therefore tolerate the whole `StopReason` union, `pending`
 * included: the isolated engine protocol, the RPC message projection, branch
 * summaries and Verbatim Compaction. Each is driven with every member of the
 * union; an unhandled variant would throw rather than fail an assertion, so the
 * probes also pin the outcome each reason produces.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, StopReason } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { generateBranchSummary } from "../../packages/coding-agent/src/core/compaction/branch-summarization.js";
import { planDeletedLineRanges } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../../packages/coding-agent/src/modes/rpc/jsonl.js";
import type { RpcEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-types.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { borrowed, PARAMETERS, region, scriptedStream, testModel } from "./compaction-rung-support.js";

/**
 * Every member of the union. Declared as a total `Record<StopReason, true>` so a
 * variant added by a future pi-ai release fails `tsc` here rather than quietly
 * going unprobed.
 */
const STOP_REASON_COVERAGE = {
	pending: true,
	stop: true,
	length: true,
	toolUse: true,
	error: true,
	aborted: true,
} satisfies Record<StopReason, true>;

const ALL_STOP_REASONS = Object.keys(STOP_REASON_COVERAGE) as StopReason[];

function assistantWith(stopReason: StopReason): AssistantMessage {
	return { ...fauxAssistantMessage("body text", { stopReason }), timestamp: 1 };
}

/** Replay session events through the exact JSONL projection RPC mode writes. */
async function projectThroughRpcWire(events: readonly RpcEvent[]): Promise<RpcEvent[]> {
	const stream = new PassThrough();
	const received: RpcEvent[] = [];
	const drained = new Promise<void>((resolve) => {
		attachJsonlLineReader(stream, (line) => received.push(JSON.parse(line) as RpcEvent), { onDrained: resolve });
	});
	for (const event of events) stream.write(serializeJsonLine(event));
	stream.end();
	await drained;
	return received;
}

test("every streaming partial that crosses a session surface carries the pending stop reason", async () => {
	const harness = await createHarness();
	try {
		harness.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
		await harness.session.prompt("hi");

		const assistantReasons = harness.events
			.filter(
				(event): event is Extract<RpcEvent, { type: "message_start" | "message_update" | "message_end" }> =>
					(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
					event.message.role === "assistant",
			)
			.map((event) => ({ type: event.type, stopReason: (event.message as AssistantMessage).stopReason }));

		assert.ok(assistantReasons.length >= 3, "the turn must produce a start, at least one update, and an end");
		const partials = assistantReasons.filter((entry) => entry.type !== "message_end");
		assert.ok(partials.length >= 2, "expected streaming partials before the terminal message");
		for (const partial of partials) {
			assert.equal(partial.stopReason, "pending", `${partial.type} must carry the pending partial reason`);
		}
		assert.equal(assistantReasons.at(-1)?.stopReason, "stop", "only the terminal message carries the mapped reason");
	} finally {
		harness.cleanup();
	}
});

test("the RPC message projection round-trips every stop reason, pending included", async () => {
	const events: RpcEvent[] = ALL_STOP_REASONS.map((stopReason) => ({
		type: "message_end",
		message: assistantWith(stopReason),
	}));

	const received = await projectThroughRpcWire(events);

	assert.equal(received.length, ALL_STOP_REASONS.length);
	assert.deepEqual(
		received.map((event) => ((event as { message: AssistantMessage }).message satisfies AssistantMessage).stopReason),
		ALL_STOP_REASONS,
	);
});

test("a whole pending-carrying turn survives the RPC projection unchanged", async () => {
	const harness = await createHarness();
	try {
		harness.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
		await harness.session.prompt("hi");

		const received = await projectThroughRpcWire(harness.events);

		assert.deepEqual(
			received.map((event) => event.type),
			harness.events.map((event) => event.type),
		);
		assert.deepEqual(received, JSON.parse(JSON.stringify(harness.events)) as RpcEvent[]);
	} finally {
		harness.cleanup();
	}
});

test("the isolated engine protocol carries a pending message frame at protocol version 2", () => {
	assert.equal(INTERACTIVE_ENGINE_PROTOCOL_VERSION, 2);

	for (const stopReason of ALL_STOP_REASONS) {
		const message = JSON.parse(JSON.stringify(assistantWith(stopReason))) as Record<string, unknown>;
		const frame = serializeInteractiveEngineFrame({
			type: "engine_message_render",
			componentId: `component-${stopReason}`,
			requestId: 1,
			width: 80,
			message: message as never,
			expanded: false,
			outputPad: 1,
		});

		const parsed = parseInteractiveEngineCommand(frame.trimEnd());

		assert.ok(parsed, `the engine dropped the ${stopReason} frame instead of parsing it`);
		assert.equal(parsed.type, "engine_message_render");
		assert.equal(
			(parsed as Extract<typeof parsed, { type: "engine_message_render" }>).message.stopReason,
			stopReason,
			`the ${stopReason} frame lost its stop reason across the engine boundary`,
		);
	}
});

/** A branch-summary stream that answers with one scripted assistant message. */
function summaryStream(stopReason: StopReason): StreamFn {
	return ((model: Model<string>) => ({
		result: async (): Promise<AssistantMessage> => ({
			...assistantWith(stopReason),
			api: model.api,
			provider: model.provider,
			model: model.id,
		}),
	})) as unknown as StreamFn;
}

test("branch summarization classifies every stop reason without an unhandled variant", async () => {
	const entries = [
		{
			id: "e1",
			type: "message" as const,
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user" as const, content: "summarize this branch", timestamp: 1 },
		},
	];

	for (const stopReason of ALL_STOP_REASONS) {
		const result = await generateBranchSummary(
			entries as never,
			{
				model: testModel(),
				apiKey: "probe-key",
				signal: new AbortController().signal,
				streamFn: summaryStream(stopReason),
			} as never,
		);

		if (stopReason === "aborted") {
			assert.deepEqual(result, { aborted: true }, "an aborted summary stays an abort");
			continue;
		}
		if (stopReason === "error") {
			assert.ok(result.error, "an errored summary stays an error");
			continue;
		}
		// Everything else — pending included — is a completed summary, which is
		// what a terminal reason produced before the raw-stop-reason batch.
		assert.equal(result.error, undefined, `${stopReason} must not become a summarization failure`);
		assert.equal(result.aborted, undefined, `${stopReason} must not be reported as an abort`);
		assert.match(result.summary ?? "", /body text/u, `${stopReason} lost the summary text`);
	}
});

test("the compaction range planner classifies every stop reason without an unhandled variant", async () => {
	for (const stopReason of ALL_STOP_REASONS) {
		const stream = scriptedStream({ default: [{ text: "5,12\n", stopReason }] });
		const plan = () =>
			planDeletedLineRanges(region(40), PARAMETERS, borrowed(testModel(), "high"), 20, {
				streamFn: stream.streamFn,
			});

		if (stopReason === "aborted") {
			await assert.rejects(plan, /Compaction cancelled/u, "an aborted plan stays a cancellation");
			continue;
		}

		const outcome = await plan();
		if (stopReason === "error") {
			assert.equal(outcome.kind, "providerError");
			continue;
		}
		// `pending`, `stop` and `toolUse` all parse the ranges; `length` takes the
		// truncation-recovery path. None may throw, and none may lose the range.
		assert.ok(
			outcome.kind === "ranked" || outcome.kind === "recovered",
			`${stopReason} produced ${outcome.kind} instead of usable ranges`,
		);
		assert.deepEqual(
			(outcome.ranges as ReadonlyArray<{ start: number; end: number }>).map((range) => ({
				start: Number(range.start),
				end: Number(range.end),
			})),
			[{ start: 5, end: 12 }],
		);
	}
});
