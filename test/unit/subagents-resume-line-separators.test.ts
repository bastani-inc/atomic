import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";

/** A live child loads its real resources; that load is the structural cost of this test. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "worker",
	description: "copies text from a web page",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/worker.md",
};

test(
	"a subagent whose JSONL transcript contains U+2028 and U+2029 can be resumed (#4957)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const directory = join(env.root, "subagent-sessions");
		const open = () => JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		const first = await open();
		const childSession = await SessionManager.create(first, env.root);
		env.faux.setResponses([fauxAssistantMessage("Copied: line\u2028break\u2029paragraph")]);
		const launched = await runSingleInProcess(env.root, agent, "Summarize a\u2028b\u2029c", {
			...env.options("resume-4957", { sessionManager: childSession, resumeSession: true }),
		});
		assert.equal(launched.status, "ok", JSON.stringify(launched));
		await first.close();

		const second = await open();
		env.faux.setResponses([fauxAssistantMessage("Resumed.")]);
		const resumed = await runSingleInProcess(env.root, agent, "Continue", {
			...env.options("resume-4957", {
				sessionManager: await SessionManager.open(second, childSession.getSessionId()),
				resumeSession: true,
				resumeTaskLiteral: true,
			}),
		});
		assert.equal(resumed.status, "ok", JSON.stringify(resumed));
		assert.equal(resumed.finalOutput, "Resumed.");
		const texts = (await second.load(childSession.getSessionId())).entries.flatMap((entry) => {
			if (entry.type !== "message") return [];
			const { content } = entry.message as { content?: string | readonly { type: string; text?: string }[] };
			if (typeof content === "string") return [content];
			return [(content ?? []).map((part) => part.text ?? "").join("")];
		});
		assert.ok(texts.includes("Summarize a\u2028b\u2029c"), JSON.stringify(texts));
		assert.ok(texts.includes("Copied: line\u2028break\u2029paragraph"), JSON.stringify(texts));
		assert.ok(texts.includes("Continue"), JSON.stringify(texts));
		await second.close();
	},
	LIVE_CHILD_TIMEOUT_MS,
);
