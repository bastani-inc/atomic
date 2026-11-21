import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSystemPromptSections } from "../src/core/system-prompt.js";

test("the system prompt puts what changes most last: install paths after the user's addendum, the date at the end", () => {
	const sections = buildSystemPromptSections({
		cwd: "/project",
		appendSystemPrompt: "Mind the house style.",
		contextFiles: [{ path: "/project/AGENTS.md", content: "Prefer small changes." }],
		sections: { session_memory: "- Recall earlier work." },
		selectedModel: { provider: "anthropic", id: "claude-opus-5-5" },
	});
	assert.deepEqual(Object.keys(sections), [
		"preamble",
		"tools",
		"rules",
		"addendum",
		"docs",
		"project_context",
		"session_memory",
		"model",
		"cwd",
		"session_folder",
		"date",
	]);
});

test("a custom section can still replace the date, model and working directory sections", () => {
	const sections = buildSystemPromptSections({ cwd: "/project", sections: { date: "Current date: unknown" } });
	assert.equal(sections.date, "<date>\nCurrent date: unknown\n</date>");
	assert.equal(Object.keys(sections).at(-1), "date");
});
