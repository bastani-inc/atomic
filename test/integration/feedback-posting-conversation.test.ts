import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { formatPreparedDisplay, submitFeedbackIssue } from "../../packages/feedback/src/index.js";

const input = { kind: "bug", title: "C", body: "B" } as const;
const prepared = formatPreparedDisplay(input, "no replacements needed.");
const entry = (id: string, message: object) => ({ type: "message", id, message }) as const;
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
	const createIssue = vi.fn(async (..._args: unknown[]) => ({
		html_url: "https://github.com/bastani-inc/atomic/issues/42",
	}));
	await submitFeedbackIssue(input, { sessionManager: { getBranch: () => branch }, transport: { createIssue } });
	assert.equal(createIssue.mock.calls.length, 1);
});
