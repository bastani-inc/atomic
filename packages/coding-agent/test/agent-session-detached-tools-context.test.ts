/**
 * The `ctx` a detachable call's work receives (#4309): the session's live tool context while the call runs inline, and
 * only `cwd` once the call has detached or was started again after a restart.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { isToolDetachmentError, type ToolDetachmentError } from "../src/index.ts";
import { harnessPool, reopenedAfterDetaching, settlesWithin, waitForCiTurn } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

type ToolUpdate = Parameters<NonNullable<ToolDefinition["execute"]>>[3];

interface ContextProbe {
	readonly definition: ToolDefinition;
	/** What each call of the tool received, in the order the calls started. */
	readonly received: { readonly ctx: ExtensionToolContext; readonly onUpdate: ToolUpdate }[];
	/** Ends every call that has started. */
	finishAll(): void;
}

/** A detachable tool that keeps the `ctx` and `onUpdate` of each call and ends only when the test says so. */
function contextProbe(): ContextProbe {
	const received: { ctx: ExtensionToolContext; onUpdate: ToolUpdate }[] = [];
	const pending: PromiseWithResolvers<void>[] = [];
	return {
		received,
		finishAll() {
			for (const call of pending) call.resolve();
		},
		definition: {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for a CI run",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: async (_toolCallId, _params, _signal, onUpdate, ctx) => {
				received.push({ ctx, onUpdate });
				const call = Promise.withResolvers<void>();
				pending.push(call);
				await call.promise;
				return { content: [{ type: "text", text: "passed" }], details: undefined };
			},
		},
	};
}

async function untilProbeStarted(probe: ContextProbe, count = 1): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (probe.received.length < count) {
		if (Date.now() > deadline) throw new Error(`the tool started ${probe.received.length} of ${count} calls`);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** The refusal reading `key` of `ctx` raises, or undefined when the read is answered. */
function refusalOf(ctx: ExtensionToolContext, key: string): ToolDetachmentError | undefined {
	try {
		void (ctx as unknown as Record<string, unknown>)[key];
		return undefined;
	} catch (error) {
		assert.ok(isToolDetachmentError(error), `reading ${key} raised a ToolDetachmentError`);
		return error;
	}
}

describe("the context of a call that runs inline (#4309)", () => {
	test("is the session's live tool context (#4309)", async () => {
		const probe = contextProbe();
		const harness = await pool.harnessWith([probe.definition]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		try {
			await untilProbeStarted(probe);
			const { ctx } = probe.received[0]!;

			assert.equal(ctx.sessionManager.getSessionId(), harness.session.sessionManager.getSessionId());
			assert.equal(typeof ctx.hasUI, "boolean");
			assert.equal(typeof ctx.isIdle, "function");
			assert.equal(ctx.cwd, harness.tempDir);
			assert.equal(refusalOf(ctx, "ui"), undefined);
			assert.equal(refusalOf(ctx, "model"), undefined);
			assert.equal((ctx as unknown as Record<string, unknown>).noSuchKey, undefined);
			assert.equal((ctx as unknown as Record<string, unknown>).then, undefined);
			assert.equal("ui" in ctx, true);
			assert.equal("cwd" in ctx, true);
			assert.equal("executeTool" in ctx, true);
			assert.equal("noSuchKey" in ctx, false);
			assert.equal("then" in ctx, false);
		} finally {
			probe.finishAll();
		}
		await settlesWithin(turn);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
	});

	test("hands the call's progress to the run (#4309)", async () => {
		const probe = contextProbe();
		const harness = await pool.harnessWith([probe.definition]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		try {
			await untilProbeStarted(probe);
			probe.received[0]!.onUpdate?.({ content: [{ type: "text", text: "queued" }], details: undefined });
		} finally {
			probe.finishAll();
		}
		await settlesWithin(turn);

		assert.equal(harness.eventsOfType("tool_execution_update").length, 1);
	});
});

describe("the context of a call that has detached (#4309)", () => {
	async function detachedProbe() {
		const probe = contextProbe();
		const harness = await pool.harnessWith([probe.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		const [call] = harness.session.takeDetachedToolCalls();
		assert.ok(call !== undefined, "the call detached");
		const { ctx, onUpdate } = probe.received[0]!;
		return { probe, harness, call, ctx, onUpdate, sessionId: harness.session.sessionManager.getSessionId() };
	}

	test("answers the cwd the call ran in (#4309)", async () => {
		const { probe, harness, call, ctx } = await detachedProbe();
		try {
			assert.equal(ctx.cwd, harness.tempDir);
			assert.equal("cwd" in ctx, true);
		} finally {
			probe.finishAll();
			await call.result;
		}
	});

	test("answers no other key: reading one raises context-detached with the session and the call (#4309)", async () => {
		const { probe, call, ctx, sessionId } = await detachedProbe();
		try {
			for (const key of ["ui", "hasUI", "model", "sessionManager", "isIdle", "signal", "executeTool", "toJSON"]) {
				const refusal = refusalOf(ctx, key);
				assert.ok(refusal !== undefined, `reading ${key} was refused`);
				assert.equal(refusal.code, "context-detached");
				assert.deepEqual(refusal.fields, { sessionId, toolCallId: "ci-1" });
				assert.match(refusal.message, new RegExp(`Tool call ci-1 detached from session ${sessionId}`));
			}
		} finally {
			probe.finishAll();
			await call.result;
		}
	});

	test("reports which keys it has: only cwd (#4309)", async () => {
		const { probe, call, ctx } = await detachedProbe();
		try {
			assert.equal("cwd" in ctx, true);
			for (const key of ["ui", "hasUI", "model", "sessionManager", "isIdle", "executeTool", "then"])
				assert.equal(key in ctx, false, `${key} is not in a detached context`);
			assert.equal(Symbol.iterator in ctx, false);
		} finally {
			probe.finishAll();
			await call.result;
		}
	});

	test("is not a thenable and has nothing for inspection to find, so awaiting or logging it does not throw (#4309)", async () => {
		const { probe, call, ctx } = await detachedProbe();
		try {
			const reader = ctx as unknown as Record<string | symbol, unknown>;
			assert.equal(reader.then, undefined);
			assert.equal(reader[Symbol.toPrimitive], undefined);
			assert.equal(reader[Symbol.toStringTag], undefined);
			assert.equal(Reflect.get(ctx, Symbol.for("nodejs.util.inspect.custom")), undefined);
			assert.equal(await Promise.resolve(ctx), ctx);
		} finally {
			probe.finishAll();
			await call.result;
		}
	});

	test("drops the progress the call reports (#4309)", async () => {
		const { probe, harness, call, onUpdate } = await detachedProbe();
		try {
			const before = harness.eventsOfType("tool_execution_update").length;

			onUpdate?.({ content: [{ type: "text", text: "still queued" }], details: undefined });

			assert.equal(harness.eventsOfType("tool_execution_update").length, before);
		} finally {
			probe.finishAll();
			await call.result;
		}
	});
});

describe("the context of a call started again after a restart (#4309)", () => {
	test("answers only cwd and reports no progress from the start (#4309)", async () => {
		const probe = contextProbe();
		const { reopened } = await reopenedAfterDetaching(pool, [probe.definition], [waitForCiTurn("ci-1")]);

		const [again] = reopened.session.redispatchDetachedToolCalls();
		assert.ok(again !== undefined, "the pending call started again");
		await untilProbeStarted(probe, 2);
		const { ctx, onUpdate } = probe.received[1]!;
		try {
			assert.equal(onUpdate, undefined);
			assert.equal(ctx.cwd, reopened.tempDir);
			assert.equal("ui" in ctx, false);
			const refusal = refusalOf(ctx, "model");
			assert.ok(refusal !== undefined, "reading model was refused");
			assert.equal(refusal.code, "context-detached");
			assert.deepEqual(refusal.fields, {
				sessionId: reopened.session.sessionManager.getSessionId(),
				toolCallId: "ci-1",
			});
		} finally {
			probe.finishAll();
			await again.result;
		}
	});
});
