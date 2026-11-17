import assert from "node:assert/strict";
import { test } from "vitest";
import { formatToolActionSummary } from "../src/modes/interactive/components/tool-block-summary.ts";

test("tool action summaries use semantic arguments without leaking structured payloads (#5350)", () => {
	const cases = [
		[{ tool: "bash", text: '{"command":"git status --short","secret":"hidden-token"}' }, "Bash(git status --short)"],
		[{ tool: "read", text: '{"path":"/project/src/file.ts","secret":"hidden-token"}' }, "Read(src/file.ts)"],
		[{ tool: "write", text: '{"path":"notes.md","content":"hidden-token"}' }, "Write(notes.md)"],
		[{ tool: "bash", text: '{"action":"wait","id":"task-123","secret":"hidden-token"}' }, "Wait(task-123)"],
		[{ tool: "bash", text: "printf hello\necho hidden-token" }, "Bash(printf hello…)"],
		[{ tool: "read", text: "src/file.ts" }, "Read(src/file.ts)"],
		[{ tool: "bash", text: '{"command":"hidden-token"' }, "Bash(…)"],
		[{ tool: "read", text: '["hidden-token"' }, "Read(…)"],
		[{ tool: "custom", text: '{"api_key":"hidden-token"}' }, "custom(…)"],
		[{ tool: "custom", text: "hidden-token" }, "custom(…)"],
		[{ tool: "custom\x1b[2J\u202e", text: "hidden-token" }, "custom<U+202E>(…)"],
	] as const;
	for (const [action, expected] of cases) {
		const original = { ...action };
		const output = formatToolActionSummary(action, "/project");
		assert.equal(output, expected);
		assert.doesNotMatch(output, /hidden-token|[\r\n\x1b\u202e]|"(?:command|path|api_key)"/u);
		assert.deepEqual(action, original);
	}
});
