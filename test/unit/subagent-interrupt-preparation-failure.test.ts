import assert from "node:assert/strict";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionWriteOptions } from "../../packages/coding-agent/src/core/storage/session/types.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;
const NOTE = "context note written while the disk is full";
const BUSY_NOTE = "context note written while the session file is busy";
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

class FullDiskStore extends MemorySessionStore {
	full = false;
	rejected = 0;
	override append(sessionId: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (this.full && entries.some((entry) => JSON.stringify(entry).includes(NOTE))) {
			this.rejected += 1;
			return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
		}
		return super.append(sessionId, entries, options);
	}
}

class BusyStore extends MemorySessionStore {
	failuresLeft = 0;
	rejected = 0;
	override append(sessionId: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (this.failuresLeft > 0 && entries.some((entry) => JSON.stringify(entry).includes(BUSY_NOTE))) {
			this.failuresLeft -= 1;
			this.rejected += 1;
			return Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked, write"), { code: "EBUSY" }));
		}
		return super.append(sessionId, entries, options);
	}
}

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

function assistantTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			(message.content as Array<{ type: string; text?: string }>)
				.map((part) => part.text ?? `[${part.type}]`)
				.join(""),
		);
}

test.each(["with Esc during preparation", "without a second Esc"] as const)(
	"an interrupted subagent whose woken turn preparation fails (%s) answers the next message and completes (#5224)",
	async (variant) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-preparation-failure" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("answered the next message"),
			fauxAssistantMessage("answered the message after that"),
		]);
		const store = new FullDiskStore();
		const preparing = Promise.withResolvers<void>();
		const releasePreparation = Promise.withResolvers<void>();
		let holdPreparation = false;
		const holdWokenTurn = (atomic: ExtensionAPI) => {
			atomic.on("before_agent_start", async () => {
				if (!holdPreparation) return;
				holdPreparation = false;
				preparing.resolve();
				await releasePreparation.promise;
			});
		};
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		let settledRuns = 0;
		const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
			...env.options(`preparation-failure-${variant}`, {
				signal: stop.signal,
				sessionManager: await SessionManager.create(store, env.root),
				resourceLoaderInheritanceSnapshot: { extensionFactories: [holdWokenTurn] },
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						if (source !== undefined || bound.chatSession === undefined) return;
						source = bound;
						(bound.chatSession as AgentSession).subscribe((event) => {
							if (event.type === "agent_settled") settledRuns += 1;
						});
					},
					onExecution() {},
				},
			}),
		}).finally(() => {
			settled = true;
		});
		try {
			await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
			const session = source!.chatSession as AgentSession;
			const sessionId = source!.getSessionId();
			await source!.interruptTurn!();
			await until(() => settledRuns === 1 && !source!.isRunning?.());
			assert.equal(settled, false);
			holdPreparation = true;
			const waking = session.sendCustomMessage(
				{ customType: "intercom", content: "carry on", display: true },
				{ triggerTurn: true },
			);
			await preparing.promise;
			assert.equal(source!.isRunning?.(), true);
			assert.equal(session.agent.state.isStreaming, false);
			await session.sendCustomMessage({ customType: "note", content: NOTE, display: false }, { triggerTurn: false });
			let interrupting: Promise<void> | undefined;
			if (variant === "with Esc during preparation") interrupting = source!.interruptTurn!();
			store.full = true;
			releasePreparation.resolve();
			await Promise.allSettled([interrupting, waking]);
			await until(() => settledRuns === 2 && !source!.isRunning?.());
			store.full = false;
			assert.ok(store.rejected > 0, "woken turn preparation failed on full disk");
			assert.equal(settled, false, "the child stays open after woken turn preparation fails");
			const textsBefore = assistantTexts(session).length;
			await session.sendCustomMessage(
				{ customType: "intercom", content: "finish the task", display: true },
				{ triggerTurn: true },
			);
			await until(() => settled);
			const answered = assistantTexts(session).slice(textsBefore);
			assert.ok(!answered.includes(""), "no turn after the failed preparation is aborted by the earlier Esc");
			assert.deepEqual(answered, ["answered the next message", "answered the message after that"]);
			const result = await run;
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "answered the message after that");
			assert.equal(source!.getSessionId(), sessionId);
		} finally {
			releasePreparation.resolve();
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

const SAVE_FAILURE_CASES = [
	{ name: "transient-esc", esc: true, failedSaves: 1 },
	{ name: "nofail-esc", esc: true, failedSaves: 0 },
	{ name: "transient-noesc", esc: false, failedSaves: 1 },
	{ name: "persistent-esc", esc: true, failedSaves: Number.POSITIVE_INFINITY },
] as const;

test.each(SAVE_FAILURE_CASES)(
	"an Esc while an interrupted subagent's woken turn starts leaves it waiting, even if a save in that turn's preparation fails ($name) (#5246)",
	async ({ name, esc, failedSaves }) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: `block-${name}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("the first reply"),
			fauxAssistantMessage("the second reply"),
			fauxAssistantMessage("the third reply"),
		]);
		const store = new BusyStore();
		const preparing = Promise.withResolvers<void>();
		const releasePreparation = Promise.withResolvers<void>();
		let holdPreparation = false;
		const holdWokenTurn = (atomic: ExtensionAPI) => {
			atomic.on("before_agent_start", async () => {
				if (!holdPreparation) return;
				holdPreparation = false;
				preparing.resolve();
				await releasePreparation.promise;
			});
		};
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		let settledRuns = 0;
		let endedTurns = 0;
		const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
			...env.options(`preparation-save-failure-${name}`, {
				signal: stop.signal,
				sessionManager: await SessionManager.create(store, env.root),
				resourceLoaderInheritanceSnapshot: { extensionFactories: [holdWokenTurn] },
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						if (source !== undefined || bound.chatSession === undefined) return;
						source = bound;
						(bound.chatSession as AgentSession).subscribe((event) => {
							if (event.type === "agent_settled") settledRuns += 1;
							if (event.type === "agent_end") endedTurns += 1;
						});
					},
					onExecution() {},
				},
			}),
		}).finally(() => {
			settled = true;
		});
		let waking: Promise<void> | undefined;
		let interrupting: Promise<void> | undefined;
		try {
			await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
			const session = source!.chatSession as AgentSession;
			await source!.interruptTurn!();
			await until(() => settledRuns === 1 && !source!.isRunning?.());
			assert.equal(settled, false);
			const textsBefore = assistantTexts(session).length;
			holdPreparation = true;
			waking = session.sendCustomMessage(
				{ customType: "intercom", content: "carry on", display: true },
				{ triggerTurn: true },
			);
			await preparing.promise;
			assert.equal(source!.isRunning?.(), true);
			assert.equal(session.agent.state.isStreaming, false);
			await session.sendCustomMessage(
				{ customType: "note", content: BUSY_NOTE, display: false },
				{ triggerTurn: false },
			);
			if (esc) interrupting = source!.interruptTurn!();
			const endedBeforeRelease = endedTurns;
			store.failuresLeft = failedSaves;
			releasePreparation.resolve();
			await Promise.allSettled([interrupting, waking]);
			if (!esc) {
				await until(() => settled);
				assert.equal(store.rejected, 1, "the woken turn's preparation failed to save once");
				const result = await run;
				assert.deepEqual(assistantTexts(session).slice(textsBefore), ["the first reply"]);
				assert.equal(result.status, "ok");
				assert.equal(result.finalOutput, "the first reply", "a woken turn that recovers completes the task");
				return;
			}
			const startedAfterRelease = failedSaves === Number.POSITIVE_INFINITY ? 0 : 1;
			await until(
				() =>
					settled ||
					(settledRuns === 2 && endedTurns - endedBeforeRelease >= startedAfterRelease && !source!.isRunning?.()),
			);
			store.failuresLeft = 0;
			assert.equal(store.rejected > 0, failedSaves > 0);
			assert.deepEqual(
				assistantTexts(session).slice(textsBefore),
				startedAfterRelease === 1 ? [""] : [],
				"the turn the Esc interrupted does not answer",
			);
			assert.equal(settled, false, "an Esc while the woken turn starts leaves the child waiting");
			await session.sendCustomMessage(
				{ customType: "intercom", content: "finish the task", display: true },
				{ triggerTurn: true },
			);
			await until(() => settled);
			const result = await run;
			const answered = assistantTexts(session).slice(textsBefore + startedAfterRelease);
			assert.ok(answered.length > 0, "the next message is answered");
			assert.ok(!answered.includes(""), "no turn after the interrupted one is aborted by its Esc");
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, answered.at(-1));
		} finally {
			releasePreparation.resolve();
			stop.abort("user");
			await Promise.allSettled([run, waking, interrupting]);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

const CORRECTION = "use the staging database instead";

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

const INTERRUPTING_MESSAGES = [
	{
		name: "an Intercom interrupt, save fails once",
		options: {
			triggerTurn: true,
			deliverAs: "interrupt",
			persistWhenStreaming: true,
			stageAdmissionKey: "intercom:correction",
		},
		failedSaves: 1,
	},
	{
		name: "an extension interrupt, save fails once",
		options: { triggerTurn: true, deliverAs: "interrupt" },
		failedSaves: 1,
	},
	{
		name: "an Intercom interrupt, no failed save",
		options: {
			triggerTurn: true,
			deliverAs: "interrupt",
			persistWhenStreaming: true,
			stageAdmissionKey: "intercom:correction",
		},
		failedSaves: 0,
	},
	{
		name: "an extension interrupt, no failed save",
		options: { triggerTurn: true, deliverAs: "interrupt" },
		failedSaves: 0,
	},
] as const;

test.each(INTERRUPTING_MESSAGES)(
	"an interrupting message sent after an Esc while a woken turn starts is answered ($name) (#5224)",
	async ({ name, options, failedSaves }) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: `block-${name}` })], { stopReason: "toolUse" }),
			answerPendingInput(),
			answerPendingInput(),
			answerPendingInput(),
			answerPendingInput(),
		]);
		const store = new BusyStore();
		const preparing = Promise.withResolvers<void>();
		const releasePreparation = Promise.withResolvers<void>();
		let holdPreparation = false;
		const holdWokenTurn = (atomic: ExtensionAPI) => {
			atomic.on("before_agent_start", async () => {
				if (!holdPreparation) return;
				holdPreparation = false;
				preparing.resolve();
				await releasePreparation.promise;
			});
		};
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		let settledRuns = 0;
		const run = runSingleInProcess(env.root, agent(), "run until interrupted", {
			...env.options(`interrupting-after-esc-${name}`, {
				signal: stop.signal,
				sessionManager: await SessionManager.create(store, env.root),
				resourceLoaderInheritanceSnapshot: { extensionFactories: [holdWokenTurn] },
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						if (source !== undefined || bound.chatSession === undefined) return;
						source = bound;
						(bound.chatSession as AgentSession).subscribe((event) => {
							if (event.type === "agent_settled") settledRuns += 1;
						});
					},
					onExecution() {},
				},
			}),
		}).finally(() => {
			settled = true;
		});
		let waking: Promise<void> | undefined;
		let interrupting: Promise<void> | undefined;
		try {
			await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
			const session = source!.chatSession as AgentSession;
			await source!.interruptTurn!();
			await until(() => settledRuns === 1 && !source!.isRunning?.());
			assert.equal(settled, false);
			const textsBefore = assistantTexts(session).length;
			holdPreparation = true;
			waking = session.sendCustomMessage(
				{ customType: "intercom", content: "carry on", display: true },
				{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: "intercom:wake" },
			);
			await preparing.promise;
			await session.sendCustomMessage(
				{ customType: "note", content: BUSY_NOTE, display: false },
				{ triggerTurn: false },
			);
			interrupting = source!.interruptTurn!();
			await session.sendCustomMessage({ customType: "intercom", content: CORRECTION, display: true }, options);
			store.failuresLeft = failedSaves;
			releasePreparation.resolve();
			await Promise.allSettled([interrupting, waking]);
			await until(() => settled);
			assert.equal(store.rejected, failedSaves);
			const answered = assistantTexts(session).slice(textsBefore);
			assert.ok(
				answered.some((text) => text.includes(CORRECTION)),
				`the message sent after the Esc is answered, not swallowed by the aborted start: ${JSON.stringify(answered)}`,
			);
			const result = await run;
			assert.equal(result.status, "ok");
		} finally {
			releasePreparation.resolve();
			stop.abort("user");
			await Promise.allSettled([run, waking, interrupting]);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
