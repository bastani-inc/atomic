import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type { AgentSessionMethodSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness, getMessageText, type HarnessOptions } from "../../packages/coding-agent/test/suite/harness.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";

type Receiver = "child" | "workflow-stage";
type Action = "send" | "ask";
type Inbound = Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];

const peer: SessionInfo = {
	id: "interrupt-peer",
	name: "interrupt-peer",
	cwd: "/peer",
	pid: 1,
	model: "faux",
	startedAt: 1,
	lastActivity: 1,
};
/** Sender-requested priority input: `delivery: "interrupt"` cancels the receiver's active work. */
function message(id: string, action: Action, text = `PRIORITY-${id}`): Message {
	return {
		id,
		timestamp: Date.now(),
		delivery: "interrupt",
		content: { text },
		...(action === "ask" ? { expectsReply: true } : {}),
	};
}

/** No `delivery` field: the default queued steer. */
function queuedMessage(id: string, action: Action, text: string): Message {
	return { id, timestamp: Date.now(), content: { text }, ...(action === "ask" ? { expectsReply: true } : {}) };
}

async function receiver(
	kind: Receiver,
	tools: AgentTool[],
	options: Pick<HarnessOptions, "settings" | "extensionFactories"> = {},
) {
	const ended = new AbortController();
	const boundary = new WorkflowStageAdmissionBoundary();
	let inbound!: Inbound;
	let ctx!: ExtensionContext;
	const h = await createHarness({
		...options,
		...(kind === "child"
			? {
					subagentPolicy: {
						managementActions: "restricted",
						fanoutAuthorized: false,
						inheritProjectContext: false,
						inheritSkills: false,
						executionEnded: ended.signal,
						depth: 1,
					},
				}
			: {
					orchestrationContext: {
						kind: "workflow-stage",
						workflowRunId: "interrupt-run",
						workflowStageId: "interrupt-stage",
						workflowStageName: "interrupt-stage",
						constraints: { disableWorkflowTool: true },
						messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
					},
				}),
		tools,
		extensionFactories: [
			(pi) => {
				intercomHeavy(pi, {
					captureInboundHandler: (handler) => {
						inbound = handler;
					},
				});
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
			...(options.extensionFactories ?? []),
		],
	});
	await h.session.bindExtensions({ mode: "print" });
	return {
		...h,
		ended,
		boundary,
		context: ctx,
		deliver: (entry: Message, from: SessionInfo = peer) => inbound(ctx, from, entry),
		async close(execution: Promise<void>) {
			ended.abort();
			void h.session.abort().catch(() => {});
			boundary.seal();
			await execution.catch(() => {});
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.session.pauseQueuedMessages();
			h.cleanup();
		},
	};
}

function cancellableTool(record: { calls: number; signal?: AbortSignal; completed: number }): {
	started: PromiseWithResolvers<void>;
	cleanup: PromiseWithResolvers<void>;
	tool: AgentTool;
} {
	const cleanup = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	return {
		started,
		cleanup,
		tool: {
			name: "long_work",
			label: "Long work",
			description: "Runs until cancelled",
			parameters: Type.Object({}),
			async execute(_id, _args, signal) {
				record.calls += 1;
				record.signal = signal;
				started.resolve();
				await Promise.race([
					cleanup.promise,
					new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				if (!signal?.aborted) record.completed += 1;
				return {
					content: [
						{ type: "text" as const, text: signal?.aborted ? "cancelled operation" : "completed operation" },
					],
					details: {},
				};
			},
		},
	};
}

// Amended 2x2 matrix: with an explicit `delivery: "interrupt"`, both actions and both receivers
// cancel supported active work immediately and continue the same task/stage with the message.
for (const kind of ["child", "workflow-stage"] as const) {
	for (const action of ["send", "ask"] as const) {
		test(`${action} with delivery interrupt to an active ${kind} cancels its long-running tool and continues the original task`, async () => {
			const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
			const work = cancellableTool(record);
			const h = await receiver(kind, [work.tool]);
			const seen: string[] = [];
			const dispatches = createDispatchCounter([
				() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
				(context) => {
					seen.push(
						...context.messages
							.filter((m) => getMessageText(m).includes("PRIORITY-"))
							.map((m) => getMessageText(m)),
					);
					return fauxAssistantMessage("amended result");
				},
			]);
			h.setResponses(dispatches.steps(4));
			const sessionId = h.session.sessionId;
			const execution = h.session.prompt("original task");
			try {
				await work.started.promise;
				await h.deliver(message(`${kind}-${action}`, action));
				await vi.waitFor(() =>
					assert.equal(record.signal?.aborted, true, "priority input must cancel the active cancellable tool"),
				);
				await execution;
				assert.equal(record.calls, 1, "the cancelled tool call is not replayed");
				assert.equal(record.completed, 0, "the tool did not need to finish naturally");
				assert.equal(seen.length, 1, "the amended turn sees the message once");
				assert.equal(dispatches.counts.valid, 2, "exactly one valid model dispatch after cancellation");
				assert.equal(h.session.sessionId, sessionId);
				assert.equal(
					h.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
					1,
					"original task prompt is not repeated",
				);
				assert.equal(getMessageText(h.session.messages.at(-1)), "amended result");
				assert.equal(
					h.sessionManager
						.getEntries()
						.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
					1,
				);
				if (action === "ask") {
					const entry = h.sessionManager
						.getEntries()
						.find((e) => e.type === "custom_message" && e.customType === "intercom_message");
					assert.ok(
						entry &&
							entry.type === "custom_message" &&
							typeof entry.content === "string" &&
							entry.content.includes("To reply, use the intercom tool"),
					);
				}
				if (kind === "workflow-stage")
					assert.equal(h.boundary.isOpen(), true, "the stage generation stays open for its host");
			} finally {
				work.cleanup.resolve();
				await h.close(execution);
			}
		});
	}
}

for (const kind of ["child", "workflow-stage"] as const) {
	for (const action of ["send", "ask"] as const) {
		test(`${action} during an SDK interrupt turn cancels that turn and drains priority input in the same ${kind}`, async () => {
			const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
			const work = cancellableTool(record);
			const h = await receiver(kind, [work.tool]);
			const sdkStarted = Promise.withResolvers<void>();
			const sdkRelease = Promise.withResolvers<void>();
			let sdkSignal: AbortSignal | undefined;
			let sdkCompletedNaturally = false;
			let amended = 0;
			const dispatches = createDispatchCounter([
				() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
				async (_context, options) => {
					sdkSignal = options?.signal;
					sdkStarted.resolve();
					await Promise.race([
						sdkRelease.promise,
						new Promise<void>((resolve) => {
							if (sdkSignal?.aborted) resolve();
							else sdkSignal?.addEventListener("abort", () => resolve(), { once: true });
						}),
					]);
					sdkCompletedNaturally = !sdkSignal?.aborted;
					return fauxAssistantMessage("SDK response");
				},
				(context) => {
					assert.equal(context.messages.filter((m) => getMessageText(m).includes("PRIORITY-sdk")).length, 1);
					amended += 1;
					return fauxAssistantMessage("amended SDK result");
				},
			]);
			h.setResponses(dispatches.steps(8));
			const sessionId = h.session.sessionId;
			const execution = h.session.prompt("original task");
			try {
				await work.started.promise;
				await h.session.sendCustomMessage(
					{ customType: "extension-interrupt", content: "SDK interrupt", display: true },
					{ triggerTurn: true, deliverAs: "interrupt" },
				);
				await sdkStarted.promise;
				const input = message("sdk", action);
				await h.deliver(input);
				await h.deliver(input);
				await execution;
				assert.equal(sdkSignal?.aborted, true, "priority input cancels the active SDK model call");
				assert.equal(sdkCompletedNaturally, false, "delivery does not wait for natural completion");
				assert.equal(amended, 1, "the original task drains admitted priority input before settling");
				assert.equal(dispatches.counts.valid, 3);
				assert.equal(h.session.sessionId, sessionId);
				assert.equal(record.calls, 1);
				assert.equal(record.completed, 0);
				assert.equal(
					h.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
					1,
				);
				assert.equal(
					h.sessionManager
						.getEntries()
						.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
					1,
				);
				assert.equal(getMessageText(h.session.messages.at(-1)), "amended SDK result");
				if (kind === "workflow-stage") assert.equal(h.boundary.isOpen(), true);
			} finally {
				sdkRelease.resolve();
				work.cleanup.resolve();
				await h.close(execution);
			}
		});
	}
}

for (const kind of ["child", "workflow-stage"] as const) {
	for (const handled of [false, true]) {
		for (const action of ["send", "ask"] as const) {
			test(`${action} admitted during ${kind} preflight is processed when input is ${handled ? "handled" : "continued"}`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let inputCalls = 0;
				const h = await receiver(kind, [], {
					extensionFactories: [
						(pi) => {
							pi.on("input", async () => {
								inputCalls += 1;
								entered.resolve();
								await release.promise;
								return { action: handled ? "handled" : "continue" };
							});
						},
					],
				});
				let amended = 0;
				const dispatches = createDispatchCounter([
					(context) => {
						assert.equal(
							context.messages.filter((m) => getMessageText(m).includes("PRIORITY-preflight")).length,
							1,
						);
						amended += 1;
						return fauxAssistantMessage("amended preflight result");
					},
				]);
				h.setResponses(dispatches.steps(4));
				const sessionId = h.session.sessionId;
				const execution = h.session.prompt("original task");
				try {
					await entered.promise;
					const input = message("preflight", action);
					await h.deliver(input);
					await h.deliver(input);
					await vi.waitFor(() =>
						assert.equal(
							h.sessionManager
								.getEntries()
								.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
							1,
						),
					);
					assert.equal(dispatches.counts.valid, 0, "admission does not start a competing task during preflight");
					release.resolve();
					await execution;
					assert.equal(amended, 1, "consuming the original input must not consume admitted Intercom input");
					assert.equal(dispatches.counts.valid, 1);
					assert.equal(inputCalls, 1, "priority continuation does not replay preflight side effects");
					assert.equal(h.session.sessionId, sessionId);
					assert.equal(
						h.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
						handled ? 0 : 1,
					);
					assert.equal(
						h.sessionManager
							.getEntries()
							.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
						1,
					);
					assert.equal(getMessageText(h.session.messages.at(-1)), "amended preflight result");
					if (kind === "workflow-stage") assert.equal(h.boundary.isOpen(), true);
				} finally {
					release.resolve();
					await h.close(execution);
				}
			});
		}
	}
}

for (const kind of ["child", "workflow-stage"] as const) {
	for (const action of ["send", "ask"] as const) {
		for (const handled of [true, false]) {
			test(`explicit abort prevents ${action} from draining ${handled ? "handled" : "continued"} ${kind} preflight`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let inputCalls = 0;
				const h = await receiver(kind, [], {
					extensionFactories: [
						(pi) => {
							pi.on("input", async () => {
								inputCalls += 1;
								entered.resolve();
								await release.promise;
								return { action: handled ? "handled" : "continue" };
							});
						},
					],
				});
				const dispatches = createDispatchCounter([() => fauxAssistantMessage("must not restart")]);
				h.setResponses(dispatches.steps(4));
				const sessionId = h.session.sessionId;
				const execution = h.session.prompt("original task");
				try {
					await entered.promise;
					const input = message("aborted-preflight", action);
					await h.deliver(input);
					await vi.waitFor(() =>
						assert.equal(
							h.sessionManager
								.getEntries()
								.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
							1,
						),
					);
					assert.equal(dispatches.counts.valid, 0);
					// Abort alone must win: neither a separate queue pause nor owner closure
					// is required to stop the prompt's deferred priority continuation.
					await h.session.abort();
					release.resolve();
					await execution;
					assert.equal(dispatches.counts.valid, 0, "preflight must not restart after explicit abort");
					assert.equal(inputCalls, 1, "preflight side effects are not replayed");
					assert.equal(h.session.sessionId, sessionId);
					assert.equal(
						h.session.messages.some((m) => m.role === "assistant"),
						false,
					);
					assert.equal(
						h.sessionManager
							.getEntries()
							.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
						1,
						"the admitted card stays durable without a model reply",
					);
				} finally {
					release.resolve();
					await h.close(execution);
				}
			});
		}
	}
}

for (const kind of ["child", "workflow-stage"] as const) {
	test(`priority input cancels an active retry model call in the same ${kind}`, async () => {
		const h = await receiver(kind, [], {
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		let natural = false;
		let amended = 0;
		const dispatches = createDispatchCounter([
			() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			async (_context, options) => {
				signal = options?.signal;
				started.resolve();
				await Promise.race([
					release.promise,
					new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				natural = !signal?.aborted;
				return fauxAssistantMessage("old retry");
			},
			(context) => {
				assert.equal(context.messages.filter((m) => getMessageText(m).includes("PRIORITY-retry")).length, 1);
				amended += 1;
				return fauxAssistantMessage("amended retry result");
			},
		]);
		h.setResponses(dispatches.steps(6));
		const sessionId = h.session.sessionId;
		const execution = h.session.prompt("original task");
		try {
			await started.promise;
			await h.deliver(message("retry", "send"));
			await execution;
			assert.equal(signal?.aborted, true);
			assert.equal(natural, false, "the retry is cancelled without releasing its natural completion gate");
			assert.equal(amended, 1);
			assert.equal(dispatches.counts.valid, 3);
			assert.equal(h.session.sessionId, sessionId);
			assert.equal(
				h.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
				1,
			);
			assert.equal(
				h.sessionManager
					.getEntries()
					.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
				1,
			);
			assert.equal(getMessageText(h.session.messages.at(-1)), "amended retry result");
			if (kind === "workflow-stage") assert.equal(h.boundary.isOpen(), true);
		} finally {
			release.resolve();
			await h.close(execution);
		}
	});
}

test("a message during model streaming cancels the stream for both receiver kinds", async () => {
	for (const kind of ["child", "workflow-stage"] as const) {
		const h = await receiver(kind, []);
		const streaming = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let amended = false;
		const dispatches = createDispatchCounter([
			(context) => {
				amended = context.messages.some((m) => getMessageText(m).includes("PRIORITY-stream"));
				return fauxAssistantMessage("amended");
			},
		]);
		h.setResponses([
			async (_context, options) => {
				streaming.resolve();
				await release.promise;
				assert.equal(options?.signal?.aborted, true);
				return fauxAssistantMessage("slow original");
			},
			...dispatches.steps(3),
		]);
		const execution = h.session.prompt("original task");
		try {
			await streaming.promise;
			await h.deliver(message(`stream-${kind}`, "send", "PRIORITY-stream"));
			await vi.waitFor(() => assert.equal(h.session.agent.signal?.aborted ?? true, true));
			release.resolve();
			await execution;
			assert.equal(amended, true);
			assert.equal(dispatches.counts.valid, 1);
		} finally {
			release.resolve();
			await h.close(execution);
		}
	}
});

test("multiple arrivals keep FIFO and dedup while the first cancellation is settling", async () => {
	const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
	const work = cancellableTool(record);
	const h = await receiver("child", [work.tool]);
	const observed: string[] = [];
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 3 }, () => (context: { messages: object[] }) => {
			for (const id of ["one", "two", "three"])
				if (!observed.includes(id) && context.messages.some((m) => getMessageText(m).includes(`PRIORITY-${id}`)))
					observed.push(id);
			return fauxAssistantMessage("amended");
		}),
	]);
	h.setResponses(dispatches.steps(8));
	const execution = h.session.prompt("original task");
	try {
		await work.started.promise;
		await Promise.all([
			h.deliver(message("one", "send")),
			h.deliver(message("two", "ask")),
			h.deliver(message("one", "send")),
			h.deliver(message("three", "send")),
		]);
		await execution;
		assert.deepEqual(observed, ["one", "two", "three"]);
		const keys = h.sessionManager
			.getEntries()
			.flatMap((e) =>
				e.type === "custom_message" && e.customType === "intercom_message" ? [e.stageAdmissionKey] : [],
			);
		assert.deepEqual(keys, ["intercom:one", "intercom:two", "intercom:three"]);
		assert.equal(record.calls, 1);
	} finally {
		work.cleanup.resolve();
		await h.close(execution);
	}
});

// R7: durable card order is insufficient; replacement must preserve model-context FIFO.
for (const transfer of [false, true]) {
	for (const action of ["send", "ask"] as const) {
		test(`${action} priority model context keeps FIFO ${transfer ? "across same-generation transfer" : "without transfer"}`, async () => {
			const source = await receiver("workflow-stage", []);
			const replacement = transfer
				? await createHarness({
						sessionManager: source.sessionManager,
						orchestrationContext: source.context.orchestrationContext,
					})
				: undefined;
			const active = replacement ?? source;
			const contexts: string[][] = [];
			const dispatches = createDispatchCounter(
				Array.from({ length: 2 }, () => (context: { messages: object[] }) => {
					contexts.push(
						context.messages.flatMap((entry) => getMessageText(entry).match(/PRIORITY-(?:first|second)/g) ?? []),
					);
					return fauxAssistantMessage("processed priority input");
				}),
			);
			active.setResponses(dispatches.steps(4));
			let execution = Promise.resolve();
			try {
				source.session.pauseQueuedMessages();
				const first = message("first", action);
				await source.deliver(first);
				await source.boundary.waitForMessageDeliveries();
				if (replacement) {
					const transferable = source.session as typeof source.session &
						Pick<AgentSessionMethodSurface, "transferWorkflowStageDeliveriesTo">;
					transferable.transferWorkflowStageDeliveriesTo(replacement.session);
				}
				assert.equal(active.session.sessionId, source.session.sessionId);
				assert.equal(source.boundary.isOpen(), true);
				// The old inbound handler remains reachable after retirement; retries stay deduplicated.
				await source.deliver(first);
				await source.deliver(message("second", action));
				await source.boundary.waitForMessageDeliveries();
				assert.deepEqual(
					source.sessionManager
						.getEntries()
						.flatMap((entry) =>
							entry.type === "custom_message" && entry.customType === "intercom_message"
								? [entry.stageAdmissionKey]
								: [],
						),
					["intercom:first", "intercom:second"],
				);
				assert.equal(dispatches.counts.valid, 0, "paused admission must not start a model turn");
				await active.session.resumeQueuedMessages();
				execution = active.session.prompt("resume stage");
				await execution;
				assert.deepEqual(contexts, [["PRIORITY-first"], ["PRIORITY-first", "PRIORITY-second"]]);
				assert.equal(dispatches.counts.valid, 2);
			} finally {
				await source.close(execution);
				replacement?.cleanup();
			}
		});
	}
}

test("an explicit abort wins: later priority input never restarts a cancelled child", async () => {
	const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
	const work = cancellableTool(record);
	const h = await receiver("child", [work.tool]);
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("must not run"),
	]);
	h.setResponses(dispatches.steps(4));
	const execution = h.session.prompt("original task");
	try {
		await work.started.promise;
		h.ended.abort();
		const abort = h.session.abort();
		await Promise.resolve(h.deliver(message("late", "ask")));
		await abort;
		await execution;
		assert.equal(dispatches.counts.valid, 1);
		assert.equal(h.session.agent.state.isStreaming, false);
		assert.equal(
			h.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "intercom_message")
				.length,
			0,
			"a terminal child does not admit the late ask",
		);
	} finally {
		work.cleanup.resolve();
		await h.close(execution);
	}
});

test("a terminal workflow generation does not reopen for priority input", async () => {
	const h = await receiver("workflow-stage", []);
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage("stage done"),
		() => fauxAssistantMessage("must not run"),
	]);
	h.setResponses(dispatches.steps(3));
	const execution = h.session.prompt("stage task");
	await execution;
	try {
		h.boundary.seal();
		await Promise.resolve(h.deliver(message("closed", "send"))).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(dispatches.counts.valid, 1);
		assert.equal(h.session.agent.state.isStreaming, false);
	} finally {
		await h.close(execution);
	}
});

// Sender-chosen delivery without interrupt, e.g. peer-to-peer swarm messaging: the
// in-flight tool call always completes. The default steer is handled right after the
// tool's turn; followUp waits until the agent would otherwise stop.
for (const kind of ["child", "workflow-stage"] as const) {
	for (const action of ["send", "ask"] as const) {
		for (const delivery of [undefined, "followUp"] as const) {
			const mode = delivery ?? "default steer";
			test(`${mode} ${action} to an active ${kind} lets its long-running tool finish and is delivered afterwards (#3921)`, async () => {
				const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
				const work = cancellableTool(record);
				const h = await receiver(kind, [work.tool]);
				const seenAtDispatch: number[] = [];
				const sees = (context: { messages: object[] }) =>
					context.messages.some((m) => getMessageText(m).includes("PEER-"));
				const dispatches = createDispatchCounter([
					() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
					(context) => {
						if (sees(context)) seenAtDispatch.push(2);
						return fauxAssistantMessage("finished the task");
					},
					(context) => {
						if (sees(context)) seenAtDispatch.push(3);
						return fauxAssistantMessage("handled follow-up");
					},
				]);
				h.setResponses(dispatches.steps(5));
				const execution = h.session.prompt("original task");
				try {
					await work.started.promise;
					await h.deliver({
						...queuedMessage(`peer-${kind}-${action}-${mode}`, action, `PEER-${kind}-${action}`),
						...(delivery === undefined ? {} : { delivery }),
					});
					await vi.waitFor(() =>
						assert.equal(
							h.sessionManager
								.getEntries()
								.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
							1,
							"the message is saved while the tool runs",
						),
					);
					await new Promise((resolve) => setTimeout(resolve, 50));
					assert.equal(record.signal?.aborted, false, "the message must not cancel the running tool");
					work.cleanup.resolve();
					await execution;
					assert.equal(record.calls, 1);
					assert.equal(record.completed, 1, "the tool call completes naturally");
					assert.equal(dispatches.counts.aborted, 0, "no model dispatch is cancelled");
					if (delivery === "followUp") {
						assert.deepEqual(seenAtDispatch, [3], "followUp waits until the agent finished and stopped");
						assert.equal(getMessageText(h.session.messages.at(-1)), "handled follow-up");
					} else {
						assert.deepEqual(seenAtDispatch, [2], "steer is delivered right after the tool call's turn");
						assert.equal(getMessageText(h.session.messages.at(-1)), "finished the task");
					}
				} finally {
					work.cleanup.resolve();
					await h.close(execution);
				}
			});
		}
	}
}

// #3921 review: a followUp ask A that arrives before a steer (or interrupt) ask B reaches the
// model after B. Each turn's implicit reply must answer the ask the model actually sees.
for (const kind of ["child", "workflow-stage"] as const) {
	for (const second of ["steer", "interrupt"] as const) {
		test(`followUp ask then ${second} ask to an active ${kind}: each implicit reply reaches the visible asker (#3921)`, async () => {
			const trackers = new Set<ReplyTracker>();
			const queueTurnContext = ReplyTracker.prototype.queueTurnContext;
			const spy = vi.spyOn(ReplyTracker.prototype, "queueTurnContext").mockImplementation(function (
				this: ReplyTracker,
				context,
			) {
				trackers.add(this);
				queueTurnContext.call(this, context);
			});
			const peerA: SessionInfo = { ...peer, id: "peer-a", name: "peer-a" };
			const peerB: SessionInfo = { ...peer, id: "peer-b", name: "peer-b" };
			const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
			const work = cancellableTool(record);
			const h = await receiver(kind, [work.tool]);
			const routed: Array<{ visible: string[]; replyTo: string; to: string }> = [];
			const observe = (context: { messages: object[] }, text: string) => {
				const visible = ["ASK-A", "ASK-B"].filter((marker) =>
					context.messages.some((m) => getMessageText(m).includes(marker)),
				);
				assert.equal(trackers.size, 1);
				const tracker = [...trackers][0]!;
				const target = tracker.resolveReplyTarget({});
				routed.push({ visible, replyTo: target.message.id, to: target.from.id });
				tracker.markReplied(target.message.id);
				return fauxAssistantMessage(text);
			};
			const dispatches = createDispatchCounter([
				() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
				(context) => observe(context, "answered B"),
				(context) => observe(context, "answered A"),
			]);
			h.setResponses(dispatches.steps(6));
			const execution = h.session.prompt("original task");
			try {
				await work.started.promise;
				await h.deliver(
					{
						...queuedMessage("ask-a", "ask", "ASK-A"),
						delivery: "followUp",
					},
					peerA,
				);
				await vi.waitFor(() =>
					assert.equal(
						h.sessionManager
							.getEntries()
							.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
						1,
					),
				);
				const askB = queuedMessage("ask-b", "ask", "ASK-B");
				void h.deliver(second === "interrupt" ? { ...askB, delivery: "interrupt" } : askB, peerB);
				if (second === "steer") {
					await vi.waitFor(() =>
						assert.equal(
							h.sessionManager
								.getEntries()
								.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
							2,
						),
					);
					work.cleanup.resolve();
				}
				await execution;
				await vi.waitFor(() => assert.equal(routed.length, 2));
				assert.deepEqual(routed, [
					{ visible: ["ASK-B"], replyTo: "ask-b", to: "peer-b" },
					{ visible: ["ASK-A", "ASK-B"], replyTo: "ask-a", to: "peer-a" },
				]);
			} finally {
				spy.mockRestore();
				work.cleanup.resolve();
				await h.close(execution);
			}
		});
	}
}

// #3921 follow-up: a reply context binds only when its message enters the model. A followUp ask A
// queued while a tool runs is not visible in the continuation after that tool, so an implicit
// reply there must not answer A; A's own turn then replies to A.
for (const kind of ["child", "workflow-stage"] as const) {
	test(`followUp ask queued during an active ${kind} tool is not the reply target of the continuation (#3921)`, async () => {
		const trackers = new Set<ReplyTracker>();
		const queueTurnContext = ReplyTracker.prototype.queueTurnContext;
		const spy = vi.spyOn(ReplyTracker.prototype, "queueTurnContext").mockImplementation(function (
			this: ReplyTracker,
			context,
		) {
			trackers.add(this);
			queueTurnContext.call(this, context);
		});
		const peerA: SessionInfo = { ...peer, id: "peer-a", name: "peer-a" };
		const record = { calls: 0, completed: 0 } as { calls: number; signal?: AbortSignal; completed: number };
		const work = cancellableTool(record);
		const h = await receiver(kind, [work.tool]);
		const routed: Array<{ visible: boolean; replyTo: string }> = [];
		const observe = (context: { messages: object[] }, text: string) => {
			const visible = context.messages.some((m) => getMessageText(m).includes("ASK-A"));
			let replyTo = "none";
			try {
				replyTo = [...trackers][0]!.resolveReplyTarget({}).message.id;
			} catch {}
			routed.push({ visible, replyTo });
			return fauxAssistantMessage(text);
		};
		const dispatches = createDispatchCounter([
			() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
			(context) => observe(context, "continued after the tool"),
			(context) => observe(context, "answered A"),
		]);
		h.setResponses(dispatches.steps(6));
		const execution = h.session.prompt("original task");
		try {
			await work.started.promise;
			await h.deliver({ ...queuedMessage("ask-a", "ask", "ASK-A"), delivery: "followUp" }, peerA);
			await vi.waitFor(
				() =>
					assert.equal(
						h.sessionManager
							.getEntries()
							.filter((e) => e.type === "custom_message" && e.customType === "intercom_message").length,
						1,
					),
				{ timeout: 5000 },
			);
			work.cleanup.resolve();
			await execution;
			await vi.waitFor(() => assert.equal(routed.length, 2));
			assert.deepEqual(routed, [
				{ visible: false, replyTo: "none" },
				{ visible: true, replyTo: "ask-a" },
			]);
		} finally {
			spy.mockRestore();
			work.cleanup.resolve();
			await h.close(execution);
		}
	});
}
