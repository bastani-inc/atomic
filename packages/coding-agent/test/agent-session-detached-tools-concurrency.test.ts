import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ToolConcurrencyMode } from "../src/core/tools/tool-concurrency.js";
import { harnessPool, persistedManager, toolResultIds } from "./helpers/detached-tools.js";
import type { Harness } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());

const PAST_ZERO_THRESHOLD_MS = 5;

function nextMacrotask(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function pastZeroThreshold(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, PAST_ZERO_THRESHOLD_MS));
}

interface GatedTool {
	readonly definition: ToolDefinition;
	readonly started: Promise<void>;
	finish(): void;
}

function gatedTool(
	name: string,
	log: string[],
	options: { readonly concurrency: ToolConcurrencyMode; readonly detachable: boolean },
): GatedTool {
	const started = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	return {
		started: started.promise,
		finish: () => pending.resolve(),
		definition: {
			name,
			label: name,
			description: `${name} for ordering`,
			parameters: Type.Object({}),
			concurrency: options.concurrency,
			...(options.detachable ? { detachable: true } : {}),
			execute: async (): Promise<AgentToolResult> => {
				log.push(`${name}:start`);
				started.resolve();
				await pending.promise;
				log.push(`${name}:end`);
				return { content: [{ type: "text", text: name }], details: undefined };
			},
		},
	};
}

async function harnessFor(tools: readonly GatedTool[], afterMs: number, names: readonly string[]): Promise<Harness> {
	const harness = await pool.harnessWith(tools.map((tool) => tool.definition));
	harness.session.setToolDetachment({ afterMs });
	harness.setResponses([
		fauxAssistantMessage(
			names.map((name) => fauxToolCall(name, {}, { id: `${name}-1` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	return harness;
}

describe("detachable calls keep their declared concurrency (#4309)", () => {
	test("an exclusive detachable call waits for earlier calls, and later calls wait while it runs inline", async () => {
		const log: string[] = [];
		const before = gatedTool("before", log, { concurrency: "shared", detachable: false });
		const exclusive = gatedTool("exclusive", log, { concurrency: "exclusive", detachable: true });
		const after = gatedTool("after", log, { concurrency: "shared", detachable: false });
		after.finish();
		const harness = await harnessFor([before, exclusive, after], 60_000, ["before", "exclusive", "after"]);

		const prompt = harness.session.prompt("go");
		await before.started;
		await nextMacrotask();
		assert.deepEqual(log, ["before:start"]);

		before.finish();
		await exclusive.started;
		await nextMacrotask();
		assert.deepEqual(log, ["before:start", "before:end", "exclusive:start"]);

		exclusive.finish();
		await prompt;
		assert.deepEqual(log, [
			"before:start",
			"before:end",
			"exclusive:start",
			"exclusive:end",
			"after:start",
			"after:end",
		]);
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["before-1", "exclusive-1", "after-1"]);
	});

	test("a shared detachable call waits for an earlier exclusive call", async () => {
		const log: string[] = [];
		const first = gatedTool("first", log, { concurrency: "exclusive", detachable: false });
		const shared = gatedTool("shared", log, { concurrency: "shared", detachable: true });
		shared.finish();
		const harness = await harnessFor([first, shared], 60_000, ["first", "shared"]);

		const prompt = harness.session.prompt("go");
		await first.started;
		await nextMacrotask();
		assert.deepEqual(log, ["first:start"]);

		first.finish();
		await prompt;
		assert.deepEqual(log, ["first:start", "first:end", "shared:start", "shared:end"]);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["first-1", "shared-1"]);
	});

	for (const [later, article] of [
		["exclusive", "an"],
		["shared", "a"],
	] as const) {
		test(`${article} ${later} call after an exclusive call waits for its work also after the call detaches`, async () => {
			const log: string[] = [];
			const before = gatedTool("before", log, { concurrency: "shared", detachable: false });
			const held = gatedTool("held", log, { concurrency: "exclusive", detachable: true });
			const next = gatedTool("next", log, { concurrency: later, detachable: false });
			next.finish();
			const harness = await harnessFor([before, held, next], 0, ["before", "held", "next"]);

			const prompt = harness.session.prompt("go");
			await before.started;
			await nextMacrotask();
			assert.deepEqual(log, ["before:start"]);

			before.finish();
			await held.started;
			await pastZeroThreshold();
			assert.deepEqual(log, ["before:start", "before:end", "held:start"]);

			held.finish();
			await prompt;
			assert.deepEqual(log, ["before:start", "before:end", "held:start", "held:end", "next:start", "next:end"]);
			const detached = harness.session.takeDetachedToolCalls();
			assert.deepEqual(
				detached.map((call) => call.toolCallId),
				["held-1"],
			);
			assert.equal((await detached[0]!.result).isError, false);
			assert.deepEqual(toolResultIds(harness.sessionManager), ["before-1", "next-1"]);
			assert.equal(harness.getPendingResponseCount(), 1);
		});
	}

	test("an exclusive call after a shared detachable call waits for its work also after the call detaches", async () => {
		const log: string[] = [];
		const held = gatedTool("held", log, { concurrency: "shared", detachable: true });
		const next = gatedTool("next", log, { concurrency: "exclusive", detachable: false });
		next.finish();
		const harness = await harnessFor([held, next], 0, ["held", "next"]);

		const prompt = harness.session.prompt("go");
		await held.started;
		await pastZeroThreshold();
		assert.deepEqual(log, ["held:start"]);

		held.finish();
		await prompt;
		assert.deepEqual(log, ["held:start", "held:end", "next:start", "next:end"]);
		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["held-1"],
		);
	});

	test("a shared call beside a shared detachable call still runs alongside it and the run ends", async () => {
		const log: string[] = [];
		const held = gatedTool("held", log, { concurrency: "shared", detachable: true });
		const next = gatedTool("next", log, { concurrency: "shared", detachable: false });
		next.finish();
		const harness = await harnessFor([held, next], 0, ["held", "next"]);

		await harness.session.prompt("go");

		assert.deepEqual([...log].sort(), ["held:start", "next:end", "next:start"]);
		const detached = harness.session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["held-1"],
		);
		held.finish();
		assert.equal((await detached[0]!.result).isError, false);
		assert.equal(log.at(-1), "held:end");
	});
});

async function reopenedOnCalls(tools: readonly GatedTool[], names: readonly string[]): Promise<Harness> {
	const { manager, store } = await persistedManager();
	await manager.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
	await manager.appendMessage(
		fauxAssistantMessage(
			names.map((name) => fauxToolCall(name, {}, { id: `${name}-1` })),
			{ stopReason: "toolUse" },
		),
	);
	return pool.harnessWith(
		tools.map((tool) => tool.definition),
		await SessionManager.open(store, manager.getSessionId()),
	);
}

describe("redispatched detachable calls keep their declared concurrency (#4309)", () => {
	for (const [first, second] of [
		["exclusive", "exclusive"],
		["exclusive", "shared"],
		["shared", "exclusive"],
	] as const) {
		test(`a redispatched ${second} call waits for an earlier redispatched ${first} call's work to settle`, async () => {
			const log: string[] = [];
			const earlier = gatedTool("earlier", log, { concurrency: first, detachable: true });
			const later = gatedTool("later", log, { concurrency: second, detachable: true });
			later.finish();
			const reopened = await reopenedOnCalls([earlier, later], ["earlier", "later"]);

			const calls = reopened.session.redispatchDetachedToolCalls();
			await earlier.started;
			await nextMacrotask();
			assert.deepEqual(log, ["earlier:start"]);

			earlier.finish();
			const results = await Promise.all(calls.map((call) => call.result));
			assert.deepEqual(log, ["earlier:start", "earlier:end", "later:start", "later:end"]);
			assert.deepEqual(
				results.map((result) => [result.toolCallId, result.isError]),
				[
					["earlier-1", false],
					["later-1", false],
				],
			);
		});
	}

	test("redispatched shared calls run alongside each other", async () => {
		const log: string[] = [];
		const earlier = gatedTool("earlier", log, { concurrency: "shared", detachable: true });
		const later = gatedTool("later", log, { concurrency: "shared", detachable: true });
		const reopened = await reopenedOnCalls([earlier, later], ["earlier", "later"]);

		const calls = reopened.session.redispatchDetachedToolCalls();
		await Promise.all([earlier.started, later.started]);
		assert.deepEqual(log, ["earlier:start", "later:start"]);

		later.finish();
		earlier.finish();
		await Promise.all(calls.map((call) => call.result));
		assert.deepEqual(log, ["earlier:start", "later:start", "later:end", "earlier:end"]);
	});

	test("an exclusive call of the continued turn waits for a redispatched call's work to settle", async () => {
		const log: string[] = [];
		const held = gatedTool("held", log, { concurrency: "shared", detachable: true });
		const next = gatedTool("next", log, { concurrency: "exclusive", detachable: false });
		next.finish();
		const reopened = await reopenedOnCalls([held, next], ["held"]);
		reopened.setResponses([
			fauxAssistantMessage([fauxToolCall("next", {}, { id: "next-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const [call] = reopened.session.redispatchDetachedToolCalls();
		await held.started;
		const resumed = reopened.session.resumeDetachedTurn([
			{
				toolCallId: "held-1",
				toolName: "held",
				result: { content: [{ type: "text", text: "held early" }], details: undefined },
				isError: false,
			},
		]);
		await pastZeroThreshold();
		assert.deepEqual(log, ["held:start"]);

		held.finish();
		await call!.result;
		await resumed;
		assert.deepEqual(log, ["held:start", "held:end", "next:start", "next:end"]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["held-1", "next-1"]);
	});
});
