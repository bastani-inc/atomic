import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { submitFeedbackIssue } from "../../packages/feedback/src/index.js";

const input = { kind: "bug", title: "C", body: "B" } as const;
const prepared = `Repository: bastani-inc/atomic\nKind: bug\n\nC\n\nB\n\nPrivacy scrubbed: no replacements needed.`;
const expected = { owner: "bastani-inc", repo: "atomic", title: "C", body: "B", labels: ["bug"] };
const entry = (id: string, message: object) => ({ type: "message", id, message }) as const;
// Regression coverage for bastani-inc/atomic#2799.
test("posts the displayed draft after a fresh conversational approval", async () => {
	const branch = [
		entry("draft", {
			role: "toolResult",
			toolName: "feedback_prepare_issue",
			content: [{ type: "text", text: prepared }],
			details: { repository: { owner: "bastani-inc", repo: "atomic" }, ...input },
		}),
		entry("display", { role: "assistant", content: prepared }),
		entry("approval", { role: "user", content: "post it" }),
	] as const;
	const response = { html_url: "https://github.com/bastani-inc/atomic/issues/42" };
	const createIssue = vi.fn(async (..._args: unknown[]) => response);
	await submitFeedbackIssue(input, { sessionManager: { getBranch: () => branch }, transport: { createIssue } });
	assert.deepEqual([createIssue.mock.calls.length, createIssue.mock.calls[0]?.[0]], [1, expected]);
});
