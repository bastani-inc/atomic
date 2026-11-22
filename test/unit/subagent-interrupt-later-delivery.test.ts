import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionAPI, SendMessageOptions } from "../../packages/coding-agent/src/core/extensions/index.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
	};
}

async function until(predicate: () => boolean, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

function answerPendingInput(): FauxResponseFactory {
	return (context) => {
		const pending: string[] = [];
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index]!;
			if (message.role === "assistant") break;
			if (message.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			pending.unshift(text);
		}
		return fauxAssistantMessage(`answered: ${pending.join(" | ")}`);
	};
}

function assistantTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			(message.content as Array<{ type: string; text?: string }>)
				.map((part) => part.text ?? `[${part.type}]`)
				.join(""),
		);
}

function toolCallTurns(session: AgentSession): number {
	return session.messages.filter(
		(message) =>
			message.role === "assistant" &&
			(message.content as Array<{ type: string }>).some((part) => part.type === "toolCall"),
	).length;
}

type Delivery = "an Intercom interrupt" | "an extension interrupt" | "a chat message" | "a batch" | "a protected batch";

function deliver(session: AgentSession, extension: ExtensionAPI, delivery: Delivery, content: string): Promise<void> {
	const message = { customType: "intercom_message", content, display: true };
	const options: Record<Delivery, SendMessageOptions> = {
		"an Intercom interrupt": {
			triggerTurn: true,
			deliverAs: "interrupt",
			persistWhenStreaming: true,
			stageAdmissionKey: `intercom:${content}`,
		},
		"an extension interrupt": { triggerTurn: true, deliverAs: "interrupt" },
		"a chat message": { triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: `intercom:${content}` },
		"a batch": { triggerTurn: true },
		"a protected batch": { triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: `intercom:${content}` },
	};
	if (delivery === "a batch" || delivery === "a protected batch") {
		const { triggerTurn, persistWhenStreaming, stageAdmissionKey } = options[delivery];
		return Promise.resolve(
			extension.sendMessages([message], { triggerTurn, persistWhenStreaming, stageAdmissionKey }),
		);
	}
	return session.sendCustomMessage(message, options[delivery]);
}

async function interruptedChild(name: string, responses: Parameters<typeof fauxAssistantMessage>[0][]) {
	const env = await liveChildEnvironment(cleanups);
	env.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("block", {}, { id: `block-${name}` })], { stopReason: "toolUse" }),
		...responses.map((content) =>
			typeof content === "string" ? answerPendingInput() : fauxAssistantMessage(content, { stopReason: "toolUse" }),
		),
		answerPendingInput(),
		answerPendingInput(),
	]);
	let source: TaskTranscriptSource | undefined;
	let extension: ExtensionAPI | undefined;
	const stop = new AbortController();
	const state = { settled: false, settledRuns: 0 };
	const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
		...env.options(name, {
			signal: stop.signal,
			resourceLoaderInheritanceSnapshot: {
				extensionFactories: [
					(atomic) => {
						extension = atomic;
					},
				],
			},
			taskExecution: {
				signal: stop.signal,
				reportActivity() {},
				bindTranscript(bound) {
					if (source !== undefined || bound.chatSession === undefined) return;
					source = bound;
					(bound.chatSession as AgentSession).subscribe((event) => {
						if (event.type === "agent_settled") state.settledRuns += 1;
					});
				},
				onExecution() {},
			},
		}),
	}).finally(() => {
		state.settled = true;
	});
	await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
	await source!.interruptTurn!();
	await until(() => state.settledRuns === 1 && !source!.isRunning?.());
	assert.equal(state.settled, false);
	assert.ok(extension);
	return { source: source!, session: source!.chatSession as AgentSession, extension, run, stop, state };
}

test.each(["an Intercom interrupt", "an extension interrupt", "a batch", "a protected batch"] as const)(
	"an interrupted subagent woken by %s answers it and completes (#5224)",
	async (delivery) => {
		const child = await interruptedChild(`later-${delivery}`, ["answer"]);
		try {
			const textsBefore = assistantTexts(child.session).length;
			await deliver(child.session, child.extension, delivery, "the build is green");
			await until(() => child.state.settled);
			const result = await child.run;
			assert.deepEqual(assistantTexts(child.session).slice(textsBefore), ["answered: the build is green"]);
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "answered: the build is green");
		} finally {
			child.stop.abort("user");
			await child.run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each(["an Intercom interrupt", "an extension interrupt", "a chat message"] as const)(
	"an Esc during the turn %s started leaves the subagent waiting, and the next message completes it (#5224)",
	async (delivery) => {
		const child = await interruptedChild(`esc-after-${delivery}`, [
			[fauxToolCall("block", {}, { id: `block-again-${delivery}` })],
		]);
		try {
			await deliver(child.session, child.extension, delivery, "look again");
			await until(() => toolCallTurns(child.session) === 2 && child.source.isRunning?.() === true);
			await child.source.interruptTurn!();
			await until(() => child.state.settledRuns >= 2 || !child.source.isRunning?.());
			assert.equal(child.state.settled, false, "the second Esc leaves the child waiting");
			const textsBefore = assistantTexts(child.session).length;
			await deliver(child.session, child.extension, "a chat message", "finish the task");
			await until(() => child.state.settled);
			const result = await child.run;
			assert.deepEqual(assistantTexts(child.session).slice(textsBefore), ["answered: finish the task"]);
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "answered: finish the task");
		} finally {
			child.stop.abort("user");
			await child.run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
