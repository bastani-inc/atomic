import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const verbatimDetails: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 3,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

describe("AgentSession actionable boundaries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("commits a retain-none turn_end compaction and explicitly continues once", async () => {
		let handled = false;
		const observedIds: string[] = [];
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						observedIds.push(event.messageEntryId);
						if (handled) return;
						handled = true;
						return {
							entries: [{ type: "compaction", summary: "[User]: exact handoff", firstKeptEntryId: null }],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("discarded response"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("continued from handoff");
			},
		]);

		await harness.session.prompt("discarded prompt");

		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compaction).toMatchObject({
			type: "compaction",
			summary: "[User]: exact handoff",
			firstKeptEntryId: null,
			fromHook: true,
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("exact handoff");
		expect(requests[0]).not.toContain("discarded prompt");
		expect(requests[0]).not.toContain("discarded response");
		expect(observedIds).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["steering", "follow-up", "both"] as const)(
		"preserves %s queue scheduling around a turn_end handoff",
		async (queueKind) => {
			let handled = false;
			const requests: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", () => {
							if (handled) return;
							handled = true;
							if (queueKind === "steering" || queueKind === "both") {
								pi.sendUserMessage("queued steering", { deliverAs: "steer" });
							}
							if (queueKind === "follow-up" || queueKind === "both") {
								pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
							}
							return {
								entries: [{ type: "compaction", summary: "[User]: exact handoff", firstKeptEntryId: null }],
								continue: true,
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("first"),
				(context) => {
					requests.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("second");
				},
				(context) => {
					requests.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("third");
				},
			]);

			await harness.session.prompt("start");

			expect(requests[0]).toContain("exact handoff");
			if (queueKind === "steering") {
				expect(harness.faux.state.callCount).toBe(2);
				expect(requests[0]).toContain("queued steering");
				expect(requests[0]).not.toContain("queued follow-up");
			} else if (queueKind === "follow-up") {
				expect(harness.faux.state.callCount).toBe(2);
				expect(requests[0]).toContain("queued follow-up");
			} else {
				expect(harness.faux.state.callCount).toBe(3);
				expect(requests[0]).toContain("queued steering");
				expect(requests[0]).not.toContain("queued follow-up");
				expect(requests[1]).toContain("queued follow-up");
			}
		},
	);

	it("refreshes canonical context before publishing boundary entry notifications", async () => {
		let handled = false;
		const snapshots: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (handled) return;
						handled = true;
						return {
							entries: [
								{ type: "custom", customType: "metadata", data: true },
								{
									type: "custom_message",
									customType: "visible-context",
									content: "committed context",
									display: true,
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended") snapshots.push(JSON.stringify(harness.session.messages));
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		expect(snapshots).toHaveLength(2);
		expect(snapshots.every((snapshot) => snapshot.includes("committed context"))).toBe(true);
	});

	it("waits for queued session events before each provider request so message_end replacements reach the canonical context", async () => {
		const gate = deferred();
		let gated = true;
		let requestedWhileGated = false;
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						await gate.promise;
					});
					pi.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return { message: { ...event.message, content: [{ type: "text", text: "rewritten prompt" }] } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requestedWhileGated = gated;
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		const run = harness.session.prompt("original prompt");
		await new Promise((resolve) => setTimeout(resolve, 25));
		// The user message_end handler is queued behind the blocked agent_start handler, so its
		// replacement is not persisted yet; the canonical request must wait rather than race ahead.
		expect(requests).toHaveLength(0);
		gated = false;
		gate.resolve();
		await run;

		expect(requestedWhileGated).toBe(false);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("rewritten prompt");
		expect(requests[0]).not.toContain("original prompt");
	});

	it("omits boundary-edited entries from the next request", async () => {
		let handled = false;
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (handled) return;
						handled = true;
						pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
						return {
							entries: [
								{
									type: "context_edit",
									targetId: event.messageEntryId,
									replacement: { content: "replaced assistant text" },
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("original assistant text"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("start");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("replaced assistant text");
		expect(requests[0]).not.toContain("original assistant text");
		// Raw history keeps the original attempt.
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && getMessageText(entry.message) === "original assistant text"),
		).toBe(true);
	});

	it("continues from an agent_before_settle custom message before final settlement", async () => {
		let requested = false;
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						if (requested) return;
						requested = true;
						return {
							entries: [
								{
									type: "custom_message",
									customType: "test-continuation",
									content: "continue now",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("start");

		expect(requests[0]).toContain("continue now");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "test-continuation", display: false }),
		);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("keeps a pre-settlement follow-up deferred until the explicit continuation would stop", async () => {
		let handled = false;
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						if (handled) return;
						handled = true;
						pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
						return {
							entries: [
								{
									type: "custom_message",
									customType: "boundary",
									content: "boundary context",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("second");
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(3);
		expect(requests[0]).toContain("boundary context");
		expect(requests[0]).not.toContain("queued follow-up");
		expect(requests[1]).toContain("queued follow-up");
	});

	it("defers runs started by agent_settled handlers until every settled handler completes", async () => {
		let triggered = false;
		const lifecycle: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", () => {
						lifecycle.push("start");
					});
					pi.on("agent_settled", (_event, ctx) => {
						lifecycle.push(`settled-first:${ctx.isIdle()}`);
						if (triggered) return;
						triggered = true;
						pi.sendMessage(
							{ customType: "settled-trigger", content: "start later", display: false },
							{ triggerTurn: true },
						);
					});
					pi.on("agent_settled", (_event, ctx) => {
						lifecycle.push(`settled-second:${ctx.isIdle()}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("start");

		expect(lifecycle).toEqual([
			"start",
			"settled-first:true",
			"settled-second:true",
			"start",
			"settled-first:true",
			"settled-second:true",
		]);
	});

	it("does not let an invalid explicit continuation suppress natural tool continuation", async () => {
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event, ctx) => {
						const user = [...ctx.sessionManager.getBranch()]
							.reverse()
							.find((entry) => entry.type === "message" && entry.message.role === "user");
						if (!user) throw new Error("missing user entry");
						return {
							entries: [user.id, event.messageEntryId, ...event.toolResultEntryIds].map((targetId) => ({
								type: "context_edit" as const,
								targetId,
								replacement: null,
							})),
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
	});

	it("dispatches actionable turn_end for synthetic run failures", async () => {
		let turnEnds = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						turnEnds++;
						expect(event.outcome).toBe("error");
						return { entries: [{ type: "custom", customType: "failure-boundary", data: true }] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.prepareRequest = () => {
			throw new Error("request preparation failed");
		};

		await harness.session.prompt("start");

		expect(turnEnds).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "failure-boundary" }),
		);
	});

	it("does not compact from usage belonging to a boundary-omitted assistant", async () => {
		let handled = false;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return {
							message: {
								...event.message,
								usage: { ...event.message.usage, input: 9_800, output: 1, totalTokens: 9_801 },
							},
						};
					});
					pi.on("turn_end", (event) => {
						if (handled) return;
						handled = true;
						return {
							entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("short response")]);

		await harness.session.prompt("small prompt");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		// The omitted assistant's 9,801-token usage no longer drives the estimate.
		expect(harness.session.getContextUsage()?.tokens).toBeLessThan(9_000);
	});

	it("does not trigger successful-response overflow from usage captured before a boundary edit", async () => {
		let handled = false;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 50_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return {
							message: {
								...event.message,
								usage: { ...event.message.usage, input: 51_000, output: 1, totalTokens: 51_001 },
							},
						};
					});
					pi.on("turn_end", (_event, ctx) => {
						if (handled) return;
						handled = true;
						const user = [...ctx.sessionManager.getBranch()]
							.reverse()
							.find((entry) => entry.type === "message" && entry.message.role === "user");
						if (!user) throw new Error("missing user entry");
						return { entries: [{ type: "context_edit", targetId: user.id, replacement: null }] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("large input that is later omitted");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.session.getContextUsage()?.tokens).toBeLessThan(50_000);
	});

	it("does not trigger threshold compaction from post-edit usage captured before a later compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: "small input",
			timestamp: Date.now() - 3,
		});
		harness.sessionManager.appendContextEdit(userId, { content: "edited input" });
		const response = fauxAssistantMessage("answer", { timestamp: Date.now() - 2 });
		response.usage = { ...response.usage, input: 50_000, output: 1, totalTokens: 50_001 };
		harness.sessionManager.appendMessage(response);
		harness.sessionManager.appendCompaction("[User]: small summary", userId, 50_001, verbatimDetails);
		harness.session.refreshContext();
		const runAutoCompaction = vi.spyOn(
			harness.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			},
			"_runAutoCompaction",
		);
		const checkCompaction = (
			harness.session as unknown as {
				_checkCompaction: (message: ReturnType<typeof fauxAssistantMessage>) => Promise<void>;
			}
		)._checkCompaction.bind(harness.session);
		const error = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "invalid_api_key",
			timestamp: Date.now() + 1_000,
		});

		await checkCompaction(error);

		expect(runAutoCompaction).not.toHaveBeenCalled();
	});

	it("does not treat retained pre-compaction assistant usage as post-compaction usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const retained = fauxAssistantMessage("retained");
		retained.usage = { ...retained.usage, input: 10_000, totalTokens: 10_001 };
		const retainedId = harness.sessionManager.appendMessage(retained);
		harness.sessionManager.appendCompaction("[User]: summary", retainedId, 10_001, verbatimDetails);
		harness.session.refreshContext();

		expect(harness.session.getContextUsage()?.tokens).toBeNull();
	});

	it("persists custom context sent during pre-settlement before continuing", async () => {
		let handled = false;
		const requests: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						if (handled) return;
						handled = true;
						pi.sendMessage(
							{ customType: "pending-boundary", content: "persist before continue", display: false },
							{ triggerTurn: false },
						);
						return { continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		expect(requests[0]).toContain("persist before continue");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "pending-boundary" }),
		);
	});

	it("does not consume queued input when pre-settlement drafts leave system-only context", async () => {
		let handled = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (_event, ctx) => {
						if (handled) return;
						handled = true;
						pi.sendUserMessage("still queued", { deliverAs: "followUp" });
						const targets = ctx.sessionManager
							.getBranch()
							.flatMap((entry) =>
								entry.type === "message" &&
								(entry.message.role === "user" ||
									entry.message.role === "assistant" ||
									entry.message.role === "toolResult")
									? [entry.id]
									: [],
							);
						return {
							entries: targets.map((targetId) => ({
								type: "context_edit" as const,
								targetId,
								replacement: null,
							})),
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.pendingMessageCount).toBe(1);
	});

	it("commits pre-settlement drafts but suppresses continuation when aborted during the hook", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						started.resolve();
						await release.promise;
						return {
							entries: [{ type: "custom", customType: "committed-after-abort", data: true }],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);

		const prompt = harness.session.prompt("start");
		await started.promise;
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "committed-after-abort", data: true }),
		);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});

describe("durable recovery omissions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("omits a retried provider error from model context while keeping it in raw history", async () => {
		const requests: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("failed attempt", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("retry recovered");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		expect(requests[0]).not.toContain("failed attempt");
		const entries = harness.sessionManager.getEntries();
		const failed = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
		);
		expect(failed).toBeDefined();
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: failed?.id, replacement: null }),
		);
		expect(
			harness.sessionManager
				.buildSessionProjection()
				.messages.some((message) => getMessageText(message) === "failed attempt"),
		).toBe(false);
		expect(harness.session.getLastAssistantText()).toBe("retry recovered");
	});

	it("finishes retry bookkeeping when a retry receives a nonretryable error", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(
			expect.objectContaining({ success: false, attempt: 1, finalError: "invalid_api_key" }),
		);
	});

	it("keeps follow-up work behind an automatic error retry", async () => {
		let queued = false;
		const requests: string[] = [];
		const lifecycle: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (queued || event.outcome !== "error") return;
						queued = true;
						pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" || event.type === "auto_retry_start") lifecycle.push(event.type);
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("retry recovered");
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("follow-up completed");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(3);
		expect(requests[0]).not.toContain("queued follow-up");
		expect(requests[1]).toContain("queued follow-up");
		expect(lifecycle.slice(0, 2)).toEqual(["agent_end", "auto_retry_start"]);
	});

	it("marks the exhausted retry run as final", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("start");

		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(
			expect.objectContaining({ success: false, attempt: 1 }),
		);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("resumes an admitted queued message after an interrupted empty reply through a durable omission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: "admitted queued message",
			timestamp: Date.now() - 2,
		});
		const abortedId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("", { stopReason: "aborted", timestamp: Date.now() - 1 }),
		);
		harness.session.refreshContext();

		harness.sessionManager.appendContextEdit(abortedId, null);
		harness.session.refreshContext();

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user"]);
		expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toContain(userId);
		expect(harness.sessionManager.getEntry(abortedId)).toBeDefined();
	});
});
