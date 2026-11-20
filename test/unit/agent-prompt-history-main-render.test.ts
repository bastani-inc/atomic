import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { promptHistoryFor } from "../../packages/coding-agent/src/modes/interactive/components/agent-prompt-history.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

beforeAll(() => initTheme("dark", false));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

function chat(session: Harness["session"]): InteractiveMode {
	const host = {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
	const mode = new InteractiveMode(host, { terminal: new RecordingTerminal() });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	releaseStartupChatOutput(mode);
	cleanups.push(() => mode.stop());
	return mode;
}

test("the main chat's prompts its transcript adds while a subagent is viewed wait for main: Up on the subagent never recalls them", async () => {
	const h = await createHarness();
	cleanups.push(() => h.cleanup());
	await h.sessionManager.appendMessage({ role: "user", content: "a main prompt", timestamp: 1 });
	await h.sessionManager.appendMessage({ role: "user", content: "another main prompt", timestamp: 2 });
	const mode = chat(h.session);
	const history = promptHistoryFor(mode.defaultEditor);

	history.viewAgent("task-1", ["trace the loader"]);
	mode.renderInitialMessages();
	assert.deepEqual(mode.defaultEditor.getHistory(), ["trace the loader"]);

	history.viewMain();
	assert.deepEqual(mode.defaultEditor.getHistory(), ["another main prompt", "a main prompt"]);
});
