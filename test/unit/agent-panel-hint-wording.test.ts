import assert from "node:assert/strict";
import { stripHintMarkers } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { agentPanelKeys } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { renderNavHintLine } from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.ts";

const identity = (text: string) => text;
// Hint lines are compared as the terminal shows them, without their zero-width click markers.
const style = { dim: stripHintMarkers, text: identity, muted: identity, border: identity, bold: identity };

test("focused panel hints name open and back actions in live key order at both terminal widths (#5224)", () => {
	const row = { id: "job:1", kind: "agent", state: "running", name: "debugger", task: "fix spawn locks" } as const;
	const keys = new KeybindingsManager();
	for (const width of [80, 160]) {
		assert.equal(
			renderNavHintLine(agentPanelKeys(row), width, style, keys),
			"  ↑↓ select · enter/→ to open · x stop · esc/← back to prompt · ? keys",
		);
		assert.equal(
			renderNavHintLine(agentPanelKeys(undefined), width, style, keys),
			"  ↑↓ select · enter/→ to open · esc/← back to prompt · ? keys",
		);
		assert.equal(
			renderNavHintLine(agentPanelKeys({ ...row, state: "done" }), width, style, keys),
			"  ↑↓ select · enter/→ to open · x dismiss · esc/← back to prompt · ? keys",
		);
	}
});
