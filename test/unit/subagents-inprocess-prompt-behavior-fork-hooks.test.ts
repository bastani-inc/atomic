import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import {
	assistantTurns,
	childFirstRequest,
	cleanupTempDirs,
	createChildSession,
	forkChild,
	forkParent,
	type PayloadMessage,
	parentTurn,
	resourceLoader,
} from "./subagents-inprocess-prompt-behavior-helpers.js";

afterEach(cleanupTempDirs);

describe("forked child's first request replays the parent's thinking (#5481)", () => {
	test.each(["ordinary mapping", "deferred numeric fields"])(
		"a frozen request preserves an unrelated row refreshed by the transport (%s, #5481)",
		async (mapping) => {
			const parent = forkParent();
			await parent.appendMessage({ role: "user", content: "Original prefix.", timestamp: 0 });
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "First", thinkingSignature: "sig-first" }]),
			);
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "Second", thinkingSignature: "sig-second" }]),
			);
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(api) => {
					api.on("before_provider_request", ({ payload }) => {
						const body = payload as { messages: PayloadMessage[]; max_tokens: number };
						const rows = body.messages;
						const prefix = rows[0];
						const limit = body.max_tokens;
						let transport = false;
						let reads = 0;
						Object.defineProperty(body, "max_tokens", {
							get() {
								transport = true;
								return limit;
							},
						});
						Object.defineProperty(rows, 0, {
							get() {
								assert.equal(this, rows);
								reads++;
								if (reads > 1 && !transport) throw new Error("Prefix read before transport");
								return transport ? { ...prefix, content: `Refreshed prefix ${reads}.` } : prefix;
							},
						});
						if (mapping === "deferred numeric fields") {
							// This projection has numeric fields that are unavailable until the transport starts.
							Object.defineProperty(rows, "map", {
								value(fn: (row: PayloadMessage, i: number, rows: PayloadMessage[]) => unknown, self?: unknown) {
									return Array.prototype.map.call(rows, (row: PayloadMessage, index: number) => {
										const mapped = fn.call(self, row, index, rows);
										if (mapped && typeof mapped === "object") {
											for (const [key, value] of Object.entries(mapped)) {
												if (typeof value === "number")
													Object.defineProperty(mapped, key, {
														get() {
															if (!transport) throw new Error("Numeric field read before transport");
															return value;
														},
													});
											}
										}
										return mapped;
									});
								},
							});
						}
						Object.freeze(rows);
						Object.freeze(body);
					});
				},
				parent.getCwd(),
				createEventBus(),
				runtime,
			);
			const loader = resourceLoader();
			loader.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			const session = await createChildSession({}, child, { resourceLoader: loader });
			try {
				const rows = await childFirstRequest(session);
				assert.equal(rows[0].content, "Refreshed prefix 3.");
				assert.deepEqual(assistantTurns(rows), [
					[{ type: "thinking", thinking: "Second", signature: "sig-second" }],
				]);
			} finally {
				await session.dispose();
			}
		},
	);

	test.each(["model", "earlier row", "later row", "later assistant"] as const)(
		"keeps both signed rows when serialization changes the %s (#5481)",
		async (change) => {
			const parent = forkParent();
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "First", thinkingSignature: "sig-first" }]),
			);
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "Second", thinkingSignature: "sig-second" }]),
			);
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(api) => {
					api.on("before_provider_request", ({ payload }) => {
						const body = payload as { model: string; messages: PayloadMessage[] };
						if (change === "model") {
							Object.assign(body, {
								toJSON(this: typeof body) {
									return { ...this, model: "history-relay" };
								},
							});
							return;
						}
						const last = body.messages.findLastIndex((row) => row.role === "assistant");
						const row =
							body.messages[change === "earlier row" ? last - 1 : change === "later row" ? last : last + 1];
						Object.defineProperty(row, "toJSON", {
							value() {
								return change === "later assistant"
									? { role: "assistant", content: "Transport handoff." }
									: { ...row, transport_annotation: "keep me" };
							},
						});
					});
				},
				parent.getCwd(),
				createEventBus(),
				runtime,
			);
			const loader = resourceLoader();
			loader.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			const session = await createChildSession({}, child, { resourceLoader: loader });
			try {
				const rows = await childFirstRequest(session);
				assert.deepEqual(assistantTurns(rows).slice(0, 2), [
					[{ type: "thinking", thinking: "First", signature: "sig-first" }],
					[{ type: "thinking", thinking: "Second", signature: "sig-second" }],
				]);
				if (change === "later assistant") assert.equal(assistantTurns(rows).at(-1), "Transport handoff.");
			} finally {
				await session.dispose();
			}
		},
	);

	test("sending the opening pair once does not authorize another request over the same history (#5481)", async () => {
		const parent = forkParent();
		await parent.appendMessage(parentTurn([{ type: "thinking", thinking: "First", thinkingSignature: "sig-first" }]));
		await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
		await parent.appendMessage(
			parentTurn([{ type: "thinking", thinking: "Second", thinkingSignature: "sig-second" }]),
		);
		const session = await forkChild(parent);
		try {
			assert.equal(assistantTurns(await childFirstRequest(session)).length, 1);
			assert.equal(assistantTurns(await childFirstRequest(session)).length, 2);
		} finally {
			await session.dispose();
		}
	});

	test.each(["reroute", "replace", "move", "edit"])(
		"respects a provider hook that chooses to %s the opening request (#5481)",
		async (rewrite) => {
			const parent = forkParent();
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "First", thinkingSignature: "sig-first" }]),
			);
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
			await parent.appendMessage(
				parentTurn([
					{ type: "thinking", thinking: "Second", thinkingSignature: "sig-second" },
					{ type: "text", text: "Original answer." },
				]),
			);
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(api) => {
					api.on("before_provider_request", ({ payload }) => {
						const body = payload as { model: string; messages: PayloadMessage[] };
						const i = body.messages.findIndex((row) => row.role === "assistant");
						if (rewrite === "reroute") body.model = "history-relay";
						else if (rewrite === "replace") body.messages[i] = { ...body.messages[i] };
						else if (rewrite === "move") body.messages.unshift({ role: "user", content: "Preface." });
						else (body.messages[i + 1].content as { text?: string }[])[1].text = "Revised answer.";
					});
				},
				parent.getCwd(),
				createEventBus(),
				runtime,
			);
			const loader = resourceLoader();
			loader.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			const session = await createChildSession({}, child, { resourceLoader: loader });
			try {
				assert.equal(assistantTurns(await childFirstRequest(session)).length, 2);
			} finally {
				await session.dispose();
			}
		},
	);

	test.each(["string", "blocks"])(
		"keeps earlier signed turns before a hook's later %s answer (#5481)",
		async (shape) => {
			const parent = forkParent();
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "First", thinkingSignature: "sig-first" }]),
			);
			await parent.appendCustomMessageEntry("subagent-notify", "Worker finished.", true);
			await parent.appendMessage(
				parentTurn([{ type: "thinking", thinking: "Second", thinkingSignature: "sig-second" }]),
			);
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(api) => {
					api.on("before_provider_request", ({ payload }) => {
						const body = payload as { messages: PayloadMessage[] };
						body.messages.splice(
							-1,
							0,
							{ role: "user", content: "Status?" },
							{
								role: "assistant",
								content: shape === "string" ? "Done." : [{ type: "text", text: "Done." }],
							},
						);
					});
				},
				parent.getCwd(),
				createEventBus(),
				runtime,
			);
			const loader = resourceLoader();
			loader.getExtensions = () => ({ extensions: [extension], errors: [], runtime });
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			const session = await createChildSession({}, child, { resourceLoader: loader });
			try {
				const turns = assistantTurns(await childFirstRequest(session));
				assert.deepEqual(turns[0], [{ type: "thinking", thinking: "First", signature: "sig-first" }]);
				assert.equal(turns.length, 3);
			} finally {
				await session.dispose();
			}
		},
	);
});
