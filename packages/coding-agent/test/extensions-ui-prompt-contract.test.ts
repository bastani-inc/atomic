import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionEvent, UIPromptEndEvent, UIPromptKind, UIPromptStartEvent } from "../src/index.ts";

const promptKinds: UIPromptKind[] = ["select", "confirm", "input", "editor", "custom"];

test("UI prompt extension events expose stable public payload shapes", () => {
	const events: ExtensionEvent[] = promptKinds.flatMap((kind) => {
		const start: UIPromptStartEvent = {
			type: "ui_prompt_start",
			reason: "ui_prompt",
			kind,
			title: `${kind} prompt`,
		};
		const end: UIPromptEndEvent = {
			type: "ui_prompt_end",
			reason: "ui_prompt",
			kind,
		};
		return [start, end];
	});

	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "select prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "confirm prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "input prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "input" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "editor", title: "editor prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "editor" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom", title: "custom prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
	]);
});
