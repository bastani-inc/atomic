import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE = 120_000;
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function assistantTexts(session: AgentSession | undefined): string[] {
	return (session?.messages ?? [])
		.filter((message) => message.role === "assistant")
		.map((message) =>
			(message.content as Array<{ type: string; text?: string }>)
				.map((part) => part.text ?? `[${part.type}]`)
				.join(""),
		);
}

test.each([
	{ when: "an extension interrupt arrives before it is sent", interrupt: true },
	{ when: "nothing interrupts it", interrupt: false },
])(
	"a resumed subagent answers its task when $when (#5224)",
	async ({ interrupt }) => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const first = await SessionManager.create(store, env.root);
		env.faux.setResponses([answerPendingInput()]);
		const finished = await runSingleInProcess(env.root, agent(), "first task", {
			...env.options("resumed-task-first", { sessionManager: first }),
		});
		assert.equal(finished.status ?? "ok", "ok");
		env.faux.setResponses(Array.from({ length: 6 }, () => answerPendingInput()));
		let chat: AgentSession | undefined;
		let interruptSent = false;
		let settledRuns = 0;
		const evidence: Record<string, unknown> = { interrupt };
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("agent_settled", () => {
				settledRuns += 1;
			});
			pi.on("input", async () => {
				if (!interrupt || interruptSent) return { action: "continue" as const };
				interruptSent = true;
				await pi.sendMessage(
					{ customType: "intercom_message", content: "extension interrupt", display: true },
					{ triggerTurn: true, deliverAs: "interrupt" },
				);
				const deadline = Date.now() + 20_000;
				while (settledRuns === 0 && Date.now() < deadline) await sleep(5);
				await sleep(50);
				evidence.settledRunsInHook = settledRuns;
				return { action: "continue" as const };
			});
		};
		const stop = new AbortController();
		const resumed = runSingleInProcess(env.root, agent(), "the resumed task", {
			...env.options("resumed-task-first", {
				signal: stop.signal,
				sessionManager: await SessionManager.open(store, first.getSessionId()),
				resumeSession: true,
				resumeFollowUps: ["held message"],
				resourceLoaderInheritanceSnapshot: { extensionFactories: [extensionFactory] },
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound: TaskTranscriptSource) {
						if (bound.chatSession !== undefined) chat = bound.chatSession as AgentSession;
					},
					onExecution() {},
				},
			}),
		});
		try {
			const timeout = sleep(30_000).then(() => "timeout" as const);
			const outcome = await Promise.race([resumed, timeout]);
			if (outcome === "timeout") {
				evidence.outcome = "timeout";
			} else {
				evidence.status = outcome.status;
				evidence.finalOutput = outcome.finalOutput;
			}
			evidence.assistantTexts = assistantTexts(chat);
			evidence.pendingFauxResponses = env.faux.getPendingResponseCount();
			assert.notEqual(evidence.outcome, "timeout", "the resumed child completes");
			assert.ok(
				(evidence.assistantTexts as string[]).some((text) => text.includes("the resumed task")),
				"the resumed child answers its task prompt",
			);
		} finally {
			stop.abort("user");
			await resumed.catch(() => undefined);
		}
	},
	LIVE,
);

test(
	"a resumed subagent answers an extension's interrupt and its task when the interrupt's turn still runs as the task is sent (#5318)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const first = await SessionManager.create(store, env.root);
		env.faux.setResponses([answerPendingInput()]);
		const finished = await runSingleInProcess(env.root, agent(), "first task", {
			...env.options("resumed-task-busy", { sessionManager: first }),
		});
		assert.equal(finished.status ?? "ok", "ok");
		env.faux.setResponses(Array.from({ length: 6 }, () => answerPendingInput()));
		let chat: AgentSession | undefined;
		let interruptSent = false;
		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("input", () => {
				if (!interruptSent) {
					interruptSent = true;
					void pi.sendMessage(
						{ customType: "intercom_message", content: "extension interrupt", display: true },
						{ triggerTurn: true, deliverAs: "interrupt" },
					);
				}
				return { action: "continue" as const };
			});
		};
		const stop = new AbortController();
		const resumed = runSingleInProcess(env.root, agent(), "the resumed task", {
			...env.options("resumed-task-busy", {
				signal: stop.signal,
				sessionManager: await SessionManager.open(store, first.getSessionId()),
				resumeSession: true,
				resumeFollowUps: ["held message"],
				resourceLoaderInheritanceSnapshot: { extensionFactories: [extensionFactory] },
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound: TaskTranscriptSource) {
						if (bound.chatSession !== undefined) chat = bound.chatSession as AgentSession;
					},
					onExecution() {},
				},
			}),
		});
		try {
			const outcome = await Promise.race([resumed, sleep(30_000).then(() => "timeout" as const)]);
			assert.notEqual(outcome, "timeout", "the resumed child completes");
			if (outcome === "timeout") return;
			assert.equal(outcome.status ?? "ok", "ok", outcome.error);
			const answered = assistantTexts(chat).join("\n");
			for (const text of ["extension interrupt", "the resumed task", "held message"])
				assert.ok(answered.includes(text), `the resumed child answers ${text}`);
		} finally {
			stop.abort("user");
			await resumed.catch(() => undefined);
		}
	},
	LIVE,
);
