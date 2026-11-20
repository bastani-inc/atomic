import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, test } from "vitest";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { renderAgentPanelRows } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";

beforeAll(() => initTheme("dark"));

const worker: AgentPanelItem = {
	id: "task:a1",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "fix the parser",
	model: "openai/gpt-5",
	thinking: "high",
	elapsedMs: 12_000,
};
const shell: AgentPanelItem = {
	id: "task:s1",
	kind: "shell",
	state: "running",
	name: "shell",
	task: "npm test",
	elapsedMs: 9_000,
};

test("a subagent's nested shell row keeps the task and right columns of its subagent's row, with the model column", () => {
	for (const width of [140, 90]) {
		const lines = renderAgentPanelRows([worker, shell], width, themedAgentPanelStyle(), {
			showMain: true,
			nestShells: true,
			viewedId: "task:a1",
		}).map((line) => stripVTControlCharacters(line));
		const [main, row, nested] = lines;
		assert.equal(main, "  ● main".padEnd(main!.length), lines.join("\n"));
		assert.ok(row!.startsWith("●  ◯ worker"), lines.join("\n"));
		assert.ok(nested!.startsWith("     ⧗ shell"), lines.join("\n"));
		// The model column shows from 100 columns: the shell's row leaves it blank and its command lines up.
		assert.equal(row!.includes("openai/gpt-5 high"), width >= 100, lines.join("\n"));
		assert.equal(nested!.indexOf("npm test"), row!.indexOf("fix the parser"), lines.join("\n"));
		assert.equal(nested!.length, width);
		assert.equal(row!.length, width);
	}
});
