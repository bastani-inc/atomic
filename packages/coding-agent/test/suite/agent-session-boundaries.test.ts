import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../src/core/agent-session-persistent-custom-messages.js";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/index.ts";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const PERSISTENCE_ERROR =
	/^<session> message_end: could not persist the (\w+) message: Session conflict: \S+, expected \d+, actual \d+$/;

/** A session saved to a real JSONL file, with the reported extension errors (#4226). */
async function createSavedSession(options: Parameters<typeof createHarness>[0] = {}) {
	const sessionDir = mkdtempSync(join(tmpdir(), "atomic-4226-"));
	const sessionManager = await SessionManager.create(sessionDir, sessionDir);
	const harness = await createHarness({ ...options, sessionManager });
	const errors: string[] = [];
	await harness.session.bindExtensions({
		shutdownHandler: () => {},
		onError: (error) => errors.push(`${error.extensionPath} ${error.event}: ${error.error}`),
	});
	return {
		harness,
		errors,
		/** Roles of the messages reported as unsaved; undefined marks any other error. */
		unsavedRoles: () => errors.map((error) => PERSISTENCE_ERROR.exec(error)?.[1]),
		/** Append to the session file as a second writer: every later append of this session conflicts. */
		writeAsSecondWriter: async () => {
			const other = await SessionManager.open(sessionManager.getSessionFile()!, sessionDir);
			await other.appendCustomEntry("other-writer", {});
		},
		cleanup: async () => {
			try {
				await harness.cleanup();
			} finally {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		},
	};
}

/** Fails instead of hanging the suite when `promise` never settles. */
async function settlesWithin<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function noopTool(run: () => Promise<void> = async () => {}): AgentTool {
	return {
		name: "noop",
		label: "Noop",
		description: "Noop",
		parameters: Type.Object({}),
		execute: async () => {
			await run();
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
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

	it("stops a prompt whose message cannot be saved and names why, instead of an unresolved turn_end entry (#4226)", async () => {
		const saved = await createSavedSession({
			tools: [noopTool()],
			extensionFactories: [(pi) => pi.on("turn_end", () => {})],
		});
		try {
			saved.harness.setResponses([
				fauxAssistantMessage("first reply"),
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("second reply"),
			]);
			await saved.harness.session.prompt("first");
			await saved.writeAsSecondWriter();

			await settlesWithin(saved.harness.session.prompt("second"));

			// The prompt's own message is the first append that fails, so the run stops before its provider request.
			assert.deepEqual(saved.unsavedRoles(), ["user"]);
			assert.equal(saved.harness.faux.state.callCount, 1);
			// No synthetic failure reply follows the unsaved message.
			assert.equal(getMessageText(saved.harness.session.messages.at(-1)), "second");
			// A context refresh shows the saved transcript; the unsaved message is not appended after it.
			saved.harness.session.refreshContext();
			assert.equal(getMessageText(saved.harness.session.messages.at(-1)), "first reply");
		} finally {
			await saved.cleanup();
		}
	});

	it("settles prompt() with the save error when a retryable provider error cannot be saved (#4226)", async () => {
		const saved = await createSavedSession({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		try {
			saved.harness.setResponses([
				async () => {
					await saved.writeAsSecondWriter();
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
				},
				fauxAssistantMessage("must not run"),
			]);

			await settlesWithin(saved.harness.session.prompt("start"));

			assert.deepEqual(saved.unsavedRoles(), ["assistant"]);
			// Nothing is retried on top of the unsaved transcript.
			assert.equal(saved.harness.faux.state.callCount, 1);
			assert.equal(saved.harness.eventsOfType("auto_retry_start").length, 0);
		} finally {
			await saved.cleanup();
		}
	});

	it("settles without running the tool when a tool_call extension is active and the tool call cannot be saved (#4226)", async () => {
		let executed = 0;
		const saved = await createSavedSession({
			tools: [
				noopTool(async () => {
					executed++;
				}),
			],
			extensionFactories: [(pi) => pi.on("tool_call", () => {})],
		});
		try {
			saved.harness.setResponses([
				async () => {
					await saved.writeAsSecondWriter();
					return fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("must not run"),
			]);

			await settlesWithin(saved.harness.session.prompt("start"));

			assert.deepEqual(saved.unsavedRoles(), ["assistant"]);
			assert.equal(executed, 0);
			assert.equal(saved.harness.faux.state.callCount, 1);
		} finally {
			await saved.cleanup();
		}
	});

	it("settles without running the tool when no tool_call extension is active and the tool call cannot be saved (#4226)", async () => {
		let executed = 0;
		const saved = await createSavedSession({
			tools: [
				noopTool(async () => {
					executed++;
				}),
			],
		});
		try {
			saved.harness.setResponses([
				async () => {
					await saved.writeAsSecondWriter();
					return fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("must not run"),
			]);

			await settlesWithin(saved.harness.session.prompt("start"));

			assert.deepEqual(saved.unsavedRoles(), ["assistant"]);
			assert.equal(executed, 0);
			assert.equal(saved.harness.faux.state.callCount, 1);
		} finally {
			await saved.cleanup();
		}
	});

	it("stops a tool loop whose tool result cannot be saved before the next provider request (#4226)", async () => {
		const saved = await createSavedSession({
			tools: [
				noopTool(async () => {
					// Write once this turn's tool call is saved, so the tool result is the first append that fails.
					await vi.waitFor(() =>
						assert.ok(
							saved.harness.sessionManager
								.getEntries()
								.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
						),
					);
					await saved.writeAsSecondWriter();
				}),
			],
		});
		try {
			saved.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not run"),
			]);

			await settlesWithin(saved.harness.session.prompt("start"));

			assert.deepEqual(saved.unsavedRoles(), ["toolResult"]);
			assert.equal(saved.harness.faux.state.callCount, 1);
			// The run ends on the unsaved tool result; no synthetic failure reply follows it.
			assert.equal(saved.harness.session.messages.at(-1)?.role, "toolResult");
		} finally {
			await saved.cleanup();
		}
	});

	// A custom message saved outside its own message_end append stops the run like any other unsaved message.
	describe.each([
		{ continuation: "a terminal response", continueAtBoundary: false },
		{ continuation: "an explicit boundary continuation", continueAtBoundary: true },
	])("a custom message that cannot be saved, after $continuation (#4254)", ({ continueAtBoundary }) => {
		const NOTICE = "late-notice";

		/**
		 * A saved session whose second writer appends at `writeAt`, after the first reply is saved, so that the custom
		 * message's save is the run's first failed append. Its first turn_end boundary asks to continue when the case
		 * says so. `saveAttempts` counts the session's appends of a custom type.
		 */
		async function createCustomMessageSession(writeAt: "turn_end" | "hidden turn") {
			let written = false;
			let continued = false;
			const writeOnce = async () => {
				if (written) return;
				written = true;
				await saved.writeAsSecondWriter();
			};
			const saved = await createSavedSession({
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", async () => {
							if (writeAt === "turn_end") await writeOnce();
							if (!continueAtBoundary || continued) return;
							continued = true;
							return { continue: true };
						});
						// Extensions see the hidden turn's message_end just before it is saved.
						pi.on("message_end", async ({ message }) => {
							if (message.role === "custom" && message.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE) {
								if (writeAt === "hidden turn") await writeOnce();
							}
						});
					},
				],
			});
			const sessionManager = saved.harness.sessionManager;
			const append = sessionManager.appendCustomMessageEntry.bind(sessionManager);
			const attempts = new Map<string, number>();
			sessionManager.appendCustomMessageEntry = (customType, ...rest) => {
				attempts.set(customType, (attempts.get(customType) ?? 0) + 1);
				return append(customType, ...rest);
			};
			return { ...saved, saveAttempts: (customType: string) => attempts.get(customType) ?? 0 };
		}

		/** Sends the custom message while the first reply streams; prompt() must resolve. */
		async function promptWithCustomMessage(
			saved: Awaited<ReturnType<typeof createCustomMessageSession>>,
			options: { triggerTurn: boolean; persistWhenStreaming?: boolean },
		): Promise<void> {
			const session = saved.harness.session;
			saved.harness.setResponses([
				async () => {
					await session.sendCustomMessage(
						{ customType: NOTICE, content: "the background work finished", display: true },
						options,
					);
					return fauxAssistantMessage("first reply");
				},
				fauxAssistantMessage("must not run"),
			]);
			await settlesWithin(session.prompt("start"));
		}

		it("stops the run when the hidden turn of a protected custom message cannot be saved", async () => {
			const saved = await createCustomMessageSession("hidden turn");
			try {
				await promptWithCustomMessage(saved, { triggerTurn: true, persistWhenStreaming: true });

				assert.deepEqual(saved.unsavedRoles(), ["custom"]);
				assert.equal(saved.harness.faux.state.callCount, 1);
				assert.equal(saved.saveAttempts(PROTECTED_RECONCILIATION_CUSTOM_TYPE), 1, "the run retries no write");

				// #3105: disposal makes one final write of the hidden turn and fails with only its cause.
				await assert.rejects(settlesWithin(saved.harness.session.dispose()), (error) => {
					assert.ok(error instanceof AggregateError);
					assert.equal((error as { code?: unknown }).code, "ShutdownFailed");
					assert.deepEqual(
						error.errors.map((component: Error) => (component.cause as Error | undefined)?.name),
						["SessionConflictError"],
					);
					return true;
				});
				assert.equal(saved.saveAttempts(PROTECTED_RECONCILIATION_CUSTOM_TYPE), 2);
				assert.deepEqual(saved.unsavedRoles(), ["custom"], "disposal reports no second error");
				// The saved card keeps its recovery marker without a saved hidden turn, so a resume replays that turn.
				const reopened = await SessionManager.open(
					saved.harness.sessionManager.getSessionFile()!,
					saved.harness.sessionManager.getSessionDir(),
				);
				const customEntries = reopened.getEntries().filter((entry) => entry.type === "custom_message");
				assert.deepEqual(
					customEntries.map((entry) => [entry.customType, entry.protectedReconciliation]),
					[[NOTICE, { delivery: "steer" }]],
				);
			} finally {
				// Disposal's rejection is asserted above; cleanup still removes the fixture.
				await saved.cleanup().catch(() => {});
			}
		});

		it("stops the run when a buffered custom message cannot be saved", async () => {
			const saved = await createCustomMessageSession("turn_end");
			try {
				await promptWithCustomMessage(saved, { triggerTurn: false });

				assert.deepEqual(saved.unsavedRoles(), ["custom"]);
				assert.equal(saved.harness.faux.state.callCount, 1);
				assert.equal(saved.saveAttempts(NOTICE), 1, "settlement does not save it again");
				await settlesWithin(saved.harness.session.dispose());
				assert.deepEqual(saved.unsavedRoles(), ["custom"]);
			} finally {
				await saved.cleanup();
			}
		});
	});

	it("still fails the turn when a session listener throws on the final assistant message_end (#4226)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let thrown = false;
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant" || thrown) return;
			thrown = true;
			throw new Error("listener failed on the final reply");
		});
		harness.setResponses([fauxAssistantMessage("final reply")]);

		await harness.session.prompt("hello");

		const last = harness.session.messages.at(-1);
		assert.ok(last?.role === "assistant");
		assert.equal(last.stopReason, "error");
		assert.match(last.errorMessage ?? "", /listener failed on the final reply/);
	});

	it("does not compact from usage belonging to a boundary-omitted assistant", async () => {
		// The session's own estimate is its built-in system prompt and tools, about 8,400 tokens on Linux, several
		// hundred more on Windows, and more with every tool description added. The omitted assistant's usage is sized
		// far past it, so only that usage can reach the compaction threshold or the bound below.
		const contextWindow = 100_000;
		const reserveTokens = 300;
		const omittedInput = contextWindow - reserveTokens;
		let handled = false;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return {
							message: {
								...event.message,
								usage: {
									...event.message.usage,
									input: omittedInput,
									output: 1,
									totalTokens: omittedInput + 1,
								},
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
		// The omitted assistant's usage, past the compaction threshold, no longer drives the estimate.
		expect(harness.session.getContextUsage()?.tokens).toBeLessThan(contextWindow / 2);
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
		const userId = await harness.sessionManager.appendMessage({
			role: "user",
			content: "small input",
			timestamp: Date.now() - 3,
		});
		await harness.sessionManager.appendContextEdit(userId, { content: "edited input" });
		const response = fauxAssistantMessage("answer", { timestamp: Date.now() - 2 });
		response.usage = { ...response.usage, input: 50_000, output: 1, totalTokens: 50_001 };
		await harness.sessionManager.appendMessage(response);
		await harness.sessionManager.appendCompaction("[User]: small summary", userId, 50_001, verbatimDetails);
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
		const retainedId = await harness.sessionManager.appendMessage(retained);
		await harness.sessionManager.appendCompaction("[User]: summary", retainedId, 10_001, verbatimDetails);
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
		const userId = await harness.sessionManager.appendMessage({
			role: "user",
			content: "admitted queued message",
			timestamp: Date.now() - 2,
		});
		const abortedId = await harness.sessionManager.appendMessage(
			fauxAssistantMessage("", { stopReason: "aborted", timestamp: Date.now() - 1 }),
		);
		harness.session.refreshContext();

		await harness.sessionManager.appendContextEdit(abortedId, null);
		harness.session.refreshContext();

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user"]);
		expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toContain(userId);
		expect(harness.sessionManager.getEntry(abortedId)).toBeDefined();
	});
});
