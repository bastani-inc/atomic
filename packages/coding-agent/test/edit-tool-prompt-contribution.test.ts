import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { EMPTY_INSERT, MINUS_ROW_REJECTED } from "../src/core/tools/hashline-engine/index.ts";

const guidance = editToolSystemPromptContribution.guidelines.join("\n");

function assembledEditPrompt(): string {
	const definition = createEditToolDefinition("/workspace");
	return buildSystemPrompt({
		selectedTools: [definition.name],
		toolSnippets: definition.promptSnippet ? { [definition.name]: definition.promptSnippet } : {},
		promptGuidelines: definition.promptGuidelines,
		contextFiles: [],
		skills: [],
		cwd: "/workspace",
	});
}

describe("edit tool hashline prompt contribution", () => {
	test("includes a read-shaped reference and an example for every operation", () => {
		assert.ok(
			guidance.includes('[greet.py#A1B2]\n1:@cache\n2:def greet(name):\n3:    msg = "Hello, " + name'),
			"reference must use the exact [path#TAG] plus N:TEXT shape emitted by read",
		);
		for (const example of [
			'replace 3..3:\n+    msg = f"Hi, {name}"',
			"replace block 1:\n+@cache",
			"delete 4\n",
			"delete 3..4\n",
			"delete block 2\n",
			"insert before 5:\n+log()",
			"insert after 3:\n+    print(msg)",
			"insert after block 2:\n+audit()",
			"insert head:\n+# generated",
			'insert tail:\n+greet("everyone")',
		]) {
			assert.ok(guidance.includes(example), `missing worked example: ${example}`);
		}
		assert.ok(guidance.includes("[src/a.ts#0A3B]"));
		assert.ok(guidance.includes("[src/b.ts#1F7C]"));
		assert.ok(guidance.includes("Python folds `@cache` and `def` into one node"));
		assert.ok(guidance.includes("doc- or line-comments"));
	});

	test("shows the measured invalid shapes and their corrections", () => {
		for (const antiPattern of [
			"`-` rows are rejected; bare context rows are auto-prefixed and inserted as literal content",
			"replace block 238:+export const value = 1;",
			"delete 2..3:\n+replacement",
			"empty `insert` / `replace`",
		]) {
			assert.ok(guidance.includes(antiPattern), `missing anti-pattern: ${antiPattern}`);
		}
		// These two messages are inline in hashline-engine/parser.ts rather than exported constants.
		assert.ok(guidance.includes("payload line has no preceding hunk header"));
		assert.ok(guidance.includes("`delete N..M` has no colon and no body"));
	});

	test("does not tell the model that sibling attributes or comments sweep the construct", () => {
		assert.match(guidance, /Python folds `@dec` and `def` into one node/i);
		assert.match(guidance, /TypeScript\/Java annotations/i);
		assert.match(guidance, /Rust `#\[attr\]` and doc- or line-comments resolve alone/i);
		assert.ok(guidance.includes("duplicates the construct"));
		assert.ok(guidance.includes("use explicit 'replace N..M:'"));
		assert.doesNotMatch(
			guidance,
			/(?:attribute|doc-comment)[\s\S]{0,160}(?:sweep both|include it with the construct)/i,
		);
	});

	test("quotes the exported empty-insert rejection", () => {
		assert.ok(guidance.includes(EMPTY_INSERT));
	});

	test("quotes the exported minus-row rejection instead of paraphrasing it", () => {
		assert.ok(guidance.includes(MINUS_ROW_REJECTED));
	});

	test("warns truthfully that a bodyless concrete replace silently deletes", () => {
		assert.match(guidance, /a bodyless concrete `replace` silently deletes the range/i);
		assert.ok(guidance.includes("if deletion is intended, write `delete 4`"));
		assert.doesNotMatch(guidance, /`replace` (?:needs|requires) at least one .*body row/i);
		assert.ok(!guidance.includes("and so does `replace`"));
	});

	test("ends with the three critical rules", () => {
		assert.ok(guidance.includes("If you remember nothing else:"));
		assert.ok(guidance.includes("1. RE-GROUND AFTER EVERY EDIT."));
		assert.ok(guidance.includes("2. RANGES ARE TIGHT."));
		assert.ok(guidance.includes("3. THE BODY IS THE FINAL CONTENT."));
	});

	test("describes native tree-sitter block resolution and its qualified fallback", () => {
		assert.ok(guidance.includes("native Rust tree-sitter `blockRangeAt` primitive"));
		assert.ok(
			guidance.includes("brace/indent heuristic is the fallback only when the native binding is unavailable"),
		);
		assert.ok(!guidance.includes("resolves the closing line with a brace/indent heuristic"));
		assert.ok(guidance.includes("→ resolved lines A-B (K lines)"));
		assert.ok(guidance.includes("; body lands after line B"));
	});

	test("survives real system-prompt assembly", () => {
		const prompt = assembledEditPrompt();
		for (const sectionStart of ["Worked examples.", "Anti-patterns:", "If you remember nothing else:"]) {
			const section = editToolSystemPromptContribution.guidelines.find((guideline) =>
				guideline.startsWith(sectionStart),
			);
			assert.ok(section, `missing contribution section: ${sectionStart}`);
			assert.ok(prompt.includes(section), `assembler changed contribution section: ${sectionStart}`);
		}
		for (const visibleText of [
			"Original (the exact shape `read` returns):",
			'replace 3..3:\n+    msg = f"Hi, {name}"',
			"replace block 238:+export const value = 1;",
			"delete 2..3:\n+replacement",
			"empty `insert` / `replace`",
			"bare context rows are auto-prefixed and inserted as literal content",
			"If you remember nothing else:",
			"1. RE-GROUND AFTER EVERY EDIT.",
			"2. RANGES ARE TIGHT.",
			"3. THE BODY IS THE FINAL CONTENT.",
		]) {
			assert.ok(prompt.includes(visibleText), `assembled prompt omitted: ${visibleText}`);
		}
	});

	test("stays compact enough to survive context compaction", () => {
		// This is operational guidance for a model under compaction, not a reference manual.
		assert.ok(guidance.length <= 7_000, `edit guidance grew to ${guidance.length} characters`);
	});
});
