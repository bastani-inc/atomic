import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	assertPostableDraft,
	type BugFeedbackDraft,
	type EnhancementFeedbackDraft,
	type FeedbackDraft,
	formatIssueBody,
	validateFeedbackDraft,
} from "../../packages/feedback/src/index.js";

const bug: BugFeedbackDraft = {
	kind: "bug",
	title: "Atomic stops after a tool error",
	description: "The session stops.",
	repro: "Run `atomic`, then invoke the failing tool.",
	expected: "The session continues.",
	version: "0.9.5",
};
const enhancement: EnhancementFeedbackDraft = {
	kind: "enhancement",
	title: "Add a smaller status view",
	change: "Add a compact status view.",
	why: "It leaves more room for conversation.",
	how: "Reuse the existing status data.",
};

// Regression coverage for bastani-inc/atomic#2799.
describe("feedback draft core", () => {
	test("accepts valid drafts without replacing their identity", () => {
		for (const draft of [bug, enhancement]) {
			const result = validateFeedbackDraft(draft);
			assert.equal(result.ok, true);
			if (result.ok) assert.equal(result.draft, draft);
			assert.equal(assertPostableDraft(draft), draft);
		}
	});

	for (const [name, draft, field] of [
		["bug title", { ...bug, title: "" }, "title"],
		["bug description", { ...bug, description: " \n" }, "description"],
		["bug repro", { ...bug, repro: "\t" }, "repro"],
		["enhancement title", { ...enhancement, title: " " }, "title"],
		["enhancement change", { ...enhancement, change: "" }, "change"],
		["enhancement why", { ...enhancement, why: "\n" }, "why"],
	] as const satisfies readonly (readonly [string, FeedbackDraft, string])[]) {
		test(`rejects missing ${name}`, () => {
			const result = validateFeedbackDraft(draft);
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.errors.map(({ field: f }) => f).join(), field);
			assert.throws(() => formatIssueBody(draft), /is required/u);
		});
	}

	test("formats form fields exactly, omits absent options, and preserves text", () => {
		assert.equal(
			formatIssueBody(bug),
			"### What happened?\n\nThe session stops.\n\n### Steps to reproduce\n\nRun `atomic`, then invoke the failing tool.\n\n### Expected behavior\n\nThe session continues.\n\n### Version\n\n0.9.5",
		);
		assert.equal(
			formatIssueBody(enhancement),
			"### What do you want to change?\n\nAdd a compact status view.\n\n### Why?\n\nIt leaves more room for conversation.\n\n### How? (optional)\n\nReuse the existing status data.",
		);
		const minimal = formatIssueBody({ ...bug, description: "  kept  ", expected: "", version: "   " });
		assert.match(minimal, /What happened\?\n\n {2}kept {2}\n\n### Steps/u);
		assert.doesNotMatch(minimal, /Expected behavior|Version/u);
	});
});
