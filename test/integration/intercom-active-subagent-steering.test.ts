import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type {
	ExtensionContext,
	ExtensionFactory,
	OrchestrationContext,
} from "../../packages/coding-agent/src/core/extensions/index.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";

const sender: SessionInfo = {
	id: "peer-session",
	name: "peer",
	cwd: "/peer",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const amendment: Message = {
	id: "active-amendment",
	timestamp: 1,
	delivery: "interrupt",
	content: { text: "  /keep-this-literal\nSTEERING-NONCE  " },
};

async function childHarness(
	tools: AgentTool[] = [],
	extensions: ExtensionFactory[] = [],
	stopAfterTurn?: () => boolean,
	orchestrationContext?: OrchestrationContext,
) {
	const ended = new AbortController();
	let inbound!: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];
	let context!: ExtensionContext;
	const harness = await createHarness({
		tools,
		finishTurn: stopAfterTurn
			? (turn) => {
					// shouldStopAfterTurn previously ran only for normal responses; keep
					// the predicate off the error/aborted hard exits finishTurn now sees.
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
					return stopAfterTurn() ? ({ action: "end" } as const) : undefined;
				}
			: undefined,
		orchestrationContext,
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			executionEnded: ended.signal,
		},
		extensionFactories: [
			(pi) => {
				intercomHeavy(pi, {
					captureInboundHandler: (handler) => {
						inbound = handler;
					},
				});
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
			...extensions,
		],
	});
	await harness.session.bindExtensions({ mode: "print" });
	return {
		...harness,
		ended,
		deliver: (message: Message = amendment) => inbound(context, sender, message),
		async close() {
			ended.abort();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		},
	};
}

// Superseded by the cancellation amendment: the active tool is now cancelled when
// it supports the signal. Task, session, and tool-execution identity still hold.
test("Intercom interrupts the working child's active tool and steers it without starting a duplicate task", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let toolSignal: AbortSignal | undefined;
	let toolStarts = 0;
	const tool: AgentTool = {
		name: "working",
		label: "Working",
		description: "Hold real child work at a deterministic tool boundary",
		parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			toolStarts++;
			toolSignal = signal;
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "work finished" }], details: {} };
		},
	};
	const current = await childHarness([tool]);
	const sessionId = current.sessionManager.getSessionId();
	let nextModelContext: string[] = [];
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
		(context) => {
			nextModelContext = context.messages.map(getMessageText);
			return fauxAssistantMessage("amended result");
		},
	]);
	current.setResponses(dispatches.steps(4));
	const execution = current.session.prompt("original task");
	try {
		await started.promise;
		assert.equal(current.session.isStreaming, true);
		await current.deliver();
		await vi.waitFor(() => assert.equal(toolSignal?.aborted, true));
		release.resolve();
		await execution;
		assert.equal(nextModelContext.filter((text) => text.includes(amendment.content.text)).length, 1);
		assert.equal(current.sessionManager.getSessionId(), sessionId);
		assert.equal(toolStarts, 1);
		assert.equal(dispatches.counts.valid, 2);
		assert.equal(
			current.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
			1,
		);
		assert.equal(getMessageText(current.session.messages.at(-1)), "amended result");
	} finally {
		release.resolve();
		await execution;
		await current.close();
	}
});

test("Intercom arriving during the original child prompt preflight cannot start a competing model task", async () => {
	const preflight = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const current = await childHarness(
		[],
		[
			(pi) => {
				pi.on("before_agent_start", async () => {
					preflight.resolve();
					await release.promise;
				});
			},
		],
	);
	const contexts: string[][] = [];
	const response = (context: { messages: Parameters<typeof getMessageText>[0][] }) => {
		contexts.push(context.messages.map(getMessageText));
		return fauxAssistantMessage("result");
	};
	current.setResponses([response, response]);
	const execution = current.session.prompt("original task");
	try {
		await preflight.promise;
		assert.equal(current.session.isStreaming, false, "preflight is not a started native turn");
		await current.deliver();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(contexts.length, 0, "the original prompt must own the first model turn");
		release.resolve();
		await execution;
		assert.ok(contexts.some((messages) => messages.some((text) => text.includes(amendment.content.text))));
		assert.ok(contexts.every((messages) => messages.includes("original task")));
	} finally {
		release.resolve();
		await execution;
		await current.close();
	}
});

test("the child task drains an Intercom delivery admitted at native settlement before publishing its result", async () => {
	let sent = false;
	const contexts: string[][] = [];
	const current = await childHarness(
		[],
		[
			(pi) => {
				pi.on("agent_settled", () => {
					if (sent) return;
					sent = true;
					void current.deliver();
				});
			},
		],
	);
	current.setResponses([
		fauxAssistantMessage("original result"),
		(context) => {
			contexts.push(context.messages.map(getMessageText));
			return fauxAssistantMessage("amended result");
		},
	]);
	try {
		await current.session.prompt("original task");
		assert.equal(sent, true);
		assert.equal(contexts.length, 1, "task completion must wait for already-admitted steering");
		assert.equal(contexts[0]!.filter((text) => text.includes(amendment.content.text)).length, 1);
		assert.equal(getMessageText(current.session.messages.at(-1)), "amended result");
		assert.equal(current.session.agent.hasQueuedMessages(), false);
	} finally {
		// On RED, drain the stranded message solely to release SDK protection during teardown.
		if (current.session.agent.hasQueuedMessages()) await current.session.prompt("test cleanup");
		await current.close();
	}
});

test("cancellation during tool-safe admission cannot restart the child to consume a late steering message", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	const releaseEvent = Promise.withResolvers<void>();
	let resumedModelCalls = 0;
	const tool: AgentTool = {
		name: "working",
		label: "Working",
		description: "Hold active work",
		parameters: Type.Object({}),
		async execute() {
			toolStarted.resolve();
			await releaseTool.promise;
			return { content: [{ type: "text", text: "stopped" }], details: {} };
		},
	};
	const current = await childHarness(
		[tool],
		[
			(pi) => {
				pi.on("tool_execution_start", async () => {
					await releaseEvent.promise;
				});
			},
		],
	);
	const response: FauxResponseFactory = (_context, options) => {
		// Agent-core may dispatch its final tool-result turn with the original,
		// already-aborted signal; the provider refuses it before model work.
		if (!options?.signal?.aborted) resumedModelCalls++;
		return fauxAssistantMessage("must not resume");
	};
	current.setResponses([
		fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
		response,
		response,
		response,
		response,
	]);
	const execution = current.session.prompt("original task");
	try {
		await toolStarted.promise;
		for (const id of ["cancel-first", "cancel-second", "cancel-third"]) {
			await current.deliver({ ...amendment, id });
		}
		current.ended.abort();
		const stopped = current.session.abort();
		releaseEvent.resolve();
		releaseTool.resolve();
		await Promise.all([stopped, execution]);
		assert.equal(resumedModelCalls, 0, "cancelled execution must never consume a new model turn");
		assert.equal(current.eventsOfType("agent_start").length, 1, "no second native run may be started");
	} finally {
		releaseEvent.resolve();
		releaseTool.resolve();
		await execution;
		current.session.pauseQueuedMessages();
		await current.close();
	}
});

test("multiple arrivals stay FIFO and deduplicated across the active-tool to model transition", async () => {
	const started = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	const releaseEvent = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "working",
		label: "Working",
		description: "Hold active work",
		parameters: Type.Object({}),
		async execute() {
			started.resolve();
			await releaseTool.promise;
			return { content: [{ type: "text", text: "finished" }], details: {} };
		},
	};
	const current = await childHarness(
		[tool],
		[
			(pi) => {
				pi.on("tool_execution_start", async () => {
					await releaseEvent.promise;
				});
			},
		],
	);
	const first: Message = { id: "first", timestamp: 1, content: { text: "FIRST-AMENDMENT" } };
	const second: Message = { id: "second", timestamp: 2, content: { text: "SECOND-AMENDMENT" } };
	const contexts: string[][] = [];
	const response: FauxResponseFactory = (context) => {
		contexts.push(context.messages.map(getMessageText));
		return fauxAssistantMessage("amended result");
	};
	// The amendment cancels the run at the first arrival; this tool ignores its
	// signal, so FIFO/dedup must still hold across the natural tool completion.
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("working", {}), { stopReason: "toolUse" }),
		response,
		response,
		response,
	]);
	current.setResponses(dispatches.steps(8));
	const execution = current.session.prompt("original task");
	try {
		await started.promise;
		assert.equal(current.session.agent.state.pendingToolCalls.size, 1);
		await current.deliver(first);
		await current.deliver(first);
		releaseTool.resolve();
		await vi.waitFor(() => assert.equal(current.session.agent.state.pendingToolCalls.size, 0));
		await current.deliver(second);
		releaseEvent.resolve();
		await execution;
		const visible = current.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message");
		assert.deepEqual(
			visible.map((entry) => (entry.type === "custom_message" ? entry.stageAdmissionKey : undefined)),
			["intercom:first", "intercom:second"],
		);
		const finalContext = contexts.at(-1)!;
		for (const message of [first, second])
			assert.equal(finalContext.filter((text) => text.includes(message.content.text)).length, 1);
		assert.ok(
			finalContext.findIndex((text) => text.includes(first.content.text)) <
				finalContext.findIndex((text) => text.includes(second.content.text)),
		);
		assert.ok(
			dispatches.counts.valid >= 2 && dispatches.counts.valid <= 3,
			`valid dispatches ${dispatches.counts.valid}`,
		);
		assert.equal(
			current.session.messages.filter((m) => m.role === "user" && getMessageText(m) === "original task").length,
			1,
		);
	} finally {
		releaseEvent.resolve();
		releaseTool.resolve();
		await execution;
		await current.close();
	}
});

test("steering remains open during a model continuation admitted at the child's settlement boundary", async () => {
	const modelStarted = Promise.withResolvers<void>();
	const releaseModel = Promise.withResolvers<void>();
	let sent = false;
	const current = await childHarness(
		[],
		[
			(pi) => {
				pi.on("agent_settled", () => {
					if (sent) return;
					sent = true;
					void current.deliver({ ...amendment, id: "settlement-first" });
				});
			},
		],
	);
	let finalContext: string[] = [];
	current.setResponses([
		fauxAssistantMessage("original result"),
		async () => {
			modelStarted.resolve();
			await releaseModel.promise;
			return fauxAssistantMessage("continued result");
		},
		(context) => {
			finalContext = context.messages.map(getMessageText);
			return fauxAssistantMessage("final amended result");
		},
	]);
	const execution = current.session.prompt("original task");
	try {
		await modelStarted.promise;
		assert.equal(current.session.isStreaming, true);
		await current.deliver({ id: "active-model-second", timestamp: 2, content: { text: "SECOND-MODEL-AMENDMENT" } });
		releaseModel.resolve();
		await execution;
		assert.equal(finalContext.filter((text) => text.includes("SECOND-MODEL-AMENDMENT")).length, 1);
		assert.equal(getMessageText(current.session.messages.at(-1)), "final amended result");
	} finally {
		releaseModel.resolve();
		await execution;
		await current.close();
	}
});

test("cancellation during child preflight holds admitted steering without starting the cancelled task", async () => {
	const preflight = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const current = await childHarness(
		[],
		[
			(pi) => {
				pi.on("before_agent_start", async () => {
					preflight.resolve();
					await release.promise;
				});
			},
		],
	);
	current.setResponses([fauxAssistantMessage("must not start")]);
	const execution = current.session.prompt("original task");
	try {
		await preflight.promise;
		await current.deliver();
		await current.session.abort();
		release.resolve();
		await execution;
		assert.equal(current.eventsOfType("agent_start").length, 0);
		assert.equal(current.getPendingResponseCount(), 1);
	} finally {
		release.resolve();
		await execution;
		current.session.pauseQueuedMessages();
		await current.close();
	}
});

test("an explicit native stop holds child steering instead of spinning or restarting terminal work", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const current = await childHarness([], [], () => true);
	// The priority arrival cancels the original model call; the host stop then
	// applies to the amended turn, so the child settles instead of spinning.
	const dispatches = createDispatchCounter([() => fauxAssistantMessage("amended terminal result")]);
	current.setResponses([
		async () => {
			started.resolve();
			await release.promise;
			return fauxAssistantMessage("terminal result");
		},
		...dispatches.steps(4),
	]);
	const execution = current.session.prompt("original task");
	try {
		await started.promise;
		await current.deliver();
		release.resolve();
		await execution;
		assert.equal(dispatches.counts.valid, 1);
		assert.equal(current.session.isStreaming, false);
		await Promise.resolve(current.deliver({ id: "after-stop", timestamp: 3, content: { text: "LATE" } }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(dispatches.counts.valid, 1, "terminal work is not restarted by later input");
		assert.equal(current.session.isStreaming, false);
	} finally {
		release.resolve();
		await execution;
		await current.close();
	}
});

test("a workflow-owned child's steering and terminal lifetime stay separate from the parent's stage generation", async () => {
	const boundary = new WorkflowStageAdmissionBoundary();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const stage: OrchestrationContext = {
		kind: "workflow-stage",
		workflowRunId: "parent-run",
		workflowStageId: "parent-stage",
		workflowStageName: "parent",
		constraints: { disableWorkflowTool: true },
		messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
	};
	const current = await childHarness([], [], undefined, stage);
	let amended = false;
	current.setResponses([
		async () => {
			started.resolve();
			await release.promise;
			return fauxAssistantMessage("original result");
		},
		(context) => {
			amended = context.messages.some((message) => getMessageText(message).includes(amendment.content.text));
			return fauxAssistantMessage("amended result");
		},
	]);
	const execution = current.session.prompt("original child task");
	try {
		await started.promise;
		await current.deliver();
		release.resolve();
		await execution;
		assert.equal(amended, true);
		assert.equal(boundary.isOpen(), true, "child settlement must not seal the parent generation");
		const parentDelivery = boundary.admit(
			`intercom:${amendment.id}`,
			() => {},
			() => {
				throw new Error("parent closed");
			},
		);
		assert.equal(parentDelivery.decision, "admitted", "child delivery must not consume the parent's dedup identity");
		await parentDelivery.completion;
	} finally {
		release.resolve();
		await execution;
		await current.close();
		await boundary.close();
	}
});
