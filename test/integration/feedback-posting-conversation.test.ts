import { expect, test } from "vitest";
import {
	type FeedbackSubmissionInput,
	type IssueSubmissionTransport,
	submitFeedbackIssue,
} from "../../packages/feedback/src/index.js";

const input: FeedbackSubmissionInput = { kind: "bug", title: "Crash", body: "### What happened?\n\nCrash" };
const prepared = `Repository: bastani-inc/atomic\nKind: bug\n\nCrash\n\n${input.body}\n\nPrivacy scrubbed: no replacements needed.`;
test("posts the displayed draft after a fresh conversational approval", async () => {
	const requests: unknown[] = [];
	const branch = [
		{
			type: "message",
			id: "draft",
			message: {
				role: "toolResult",
				toolName: "feedback_prepare_issue",
				content: [{ type: "text", text: prepared }],
				details: { repository: { owner: "bastani-inc", repo: "atomic" }, ...input },
			},
		},
		{ type: "message", id: "display", message: { role: "assistant", content: prepared } },
		{ type: "message", id: "approval", message: { role: "user", content: "post it" } },
	] as const;
	const transport: IssueSubmissionTransport = {
		createIssue: async (request) => {
			requests.push(request);
			return { html_url: "https://github.com/bastani-inc/atomic/issues/42" };
		},
	};
	await submitFeedbackIssue(input, { sessionManager: { getBranch: () => branch }, transport });
	expect(requests).toEqual([
		{ owner: "bastani-inc", repo: "atomic", title: input.title, body: input.body, labels: ["bug"] },
	]);
});
