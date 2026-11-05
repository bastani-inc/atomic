import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.js";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.js";

function assembledPrompt(): string {
	const definitions = [createEditToolDefinition("/workspace"), createWriteToolDefinition("/workspace")];
	return buildSystemPrompt({
		selectedTools: definitions.map((definition) => definition.name),
		toolSnippets: Object.fromEntries(
			definitions.map((definition) => [definition.name, definition.promptSnippet ?? ""] as const),
		),
		promptGuidelines: definitions.flatMap((definition) => definition.promptGuidelines ?? []),
		contextFiles: [],
		skills: [],
		cwd: "/workspace",
	});
}

describe("edit and write prompt contributions (#4328)", () => {
	test("edit describes exact text replacement, as upstream pi does", () => {
		assert.equal(
			editToolSystemPromptContribution.snippet,
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		);
		assert.deepEqual(editToolSystemPromptContribution.guidelines, [
			"Use edit for targeted changes. Batch changes to one file in a single call.",
			"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
		]);
	});

	test("write is for new files and complete rewrites", () => {
		assert.equal(writeToolSystemPromptContribution.snippet, "Create or overwrite files");
		assert.deepEqual(writeToolSystemPromptContribution.guidelines, [
			"Use write only for new files or complete rewrites.",
		]);
	});

	test("the assembled system prompt carries both contributions and no snapshot-tag instructions", () => {
		const prompt = assembledPrompt();
		for (const text of [
			editToolSystemPromptContribution.snippet,
			...editToolSystemPromptContribution.guidelines,
			writeToolSystemPromptContribution.snippet,
			...writeToolSystemPromptContribution.guidelines,
		])
			assert.ok(prompt.includes(text), `assembled prompt omitted: ${text}`);
		assert.doesNotMatch(prompt, /\[PATH#|snapshot tag|replace N\.\.M|\+TEXT/);
	});
});
