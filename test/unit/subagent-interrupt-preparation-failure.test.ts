import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
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
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;
const NOTE = "context note written while the disk is full";
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

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + CONDITION_WAIT_MS;
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
		const holdWokenTurn = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", async () => {
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
					yieldTaskWait() {},
					isParentObserving: () => false,
				},
			}),
		}).finally(() => {
			settled = true;
		});
		try {
			await until(() => env.blockStarted());
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
