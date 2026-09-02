import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import {
	FeedbackFailureComponent,
	type FeedbackPostHandler,
	FeedbackPreviewComponent,
	FeedbackSubmissionController,
	FeedbackSubmissionTransitionError,
} from "../src/extensions/feedback/preview.ts";
import { type ScrubbedFeedbackDraft, scrubFeedbackDraft } from "../src/extensions/feedback/privacy.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SCRUBBED_TITLE = "Crash after paste in ~/project";
const SCRUBBED_BODY =
	"## What happened?\nThe editor closed with [REDACTED API TOKEN].\n\n## Steps to reproduce\n1. Paste text\n\n## Non-builtin extensions\nInactive\n\n## Extension-free reproduction\nNot tested without extensions";

function scrubbedDraft(): ScrubbedFeedbackDraft {
	return {
		draft: {
			repository: "bastani-inc/atomic",
			kind: "bug",
			label: "bug",
			title: SCRUBBED_TITLE,
			body: SCRUBBED_BODY,
		},
		replacements: [
			{
				field: "title",
				kind: "home-directory",
				description: "title: home-directory prefix replaced with ~",
				replacement: "~",
				start: SCRUBBED_TITLE.indexOf("~"),
			},
			{
				field: "body",
				kind: "api-token",
				description: "body: API or access token redacted",
				replacement: "[REDACTED API TOKEN]",
				start: SCRUBBED_BODY.indexOf("[REDACTED API TOKEN]"),
			},
		],
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("feedback preview", () => {
	test("shows the exact payload, ordered privacy changes, and action order at narrow and wide widths", () => {
		for (const width of [24, 40, 80, 100]) {
			const component = new FeedbackPreviewComponent(scrubbedDraft(), plainTheme, () => {});
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const rendered = stripAnsi(lines.join("\n"));
			const compact = rendered.replace(/\s/gu, "");
			assert.match(compact, /Repositorybastani-inc\/atomic/u);
			assert.match(compact, /Kindbug/u);
			assert.match(compact, /Crashafterpaste/u);
			assert.match(compact, /##Whathappened\?/u);
			component.handleInput("\x1b[6~");
			const continuation = stripAnsi(component.render(width).join("\n"));
			assert.match(`${rendered}\n${continuation}`.replace(/\s/gu, ""), /##Stepstoreproduce/u);
			assert.ok(rendered.indexOf("Edit") < rendered.indexOf("Post issue"));
			assert.ok(rendered.indexOf("Post issue") < rendered.indexOf("Cancel"));

			for (let page = 0; page < 10; page += 1) component.handleInput("\x1b[6~");
			const endLines = component.render(width);
			assert.ok(endLines.every((line) => visibleWidth(line) <= width));
			const end = stripAnsi(endLines.join("\n"));
			const compactEnd = end.replace(/\s/gu, "");
			assert.ok(
				compactEnd.indexOf("title:home-directoryprefixreplacedwith~") <
					compactEnd.indexOf("body:APIoraccesstokenredacted"),
			);
			assert.ok(end.indexOf("Edit") < end.indexOf("Post issue"));
			assert.ok(end.indexOf("Post issue") < end.indexOf("Cancel"));
		}

		const actions: string[] = [];
		const component = new FeedbackPreviewComponent(scrubbedDraft(), plainTheme, (action) => actions.push(action));
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		assert.deepEqual(actions, ["post"]);
	});

	test("pages a bounded 24x80 preview while keeping actions fixed and paging non-destructive", () => {
		// #2799: long accepted bodies must stay reviewable without pushing actions off a 24-row terminal.
		const actions: string[] = [];
		const bodyLines = Array.from({ length: 45 }, (_, index) => `body-line-${String(index).padStart(3, "0")}`);
		const marker = "<!-- atomic-feedback-request:viewport-request;kind:bug -->";
		const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "viewport-request");
		controller.beginEdit();
		controller.applyEdit({
			title: controller.preview.draft.title,
			body: `## What happened?\n\n${bodyLines.join("\n")}\n[REDACTED API TOKEN]\n\n## Steps to reproduce\n\nPaste text\n\n## Non-builtin extensions\n\nInactive\n\n## Extension-free reproduction\n\nNot tested without extensions`,
		});
		const component = new FeedbackPreviewComponent(controller.preview, plainTheme, (action) => actions.push(action));

		const beginningLines = component.render(80);
		const beginning = stripAnsi(beginningLines.join("\n"));
		assert.ok(beginningLines.length <= 18);
		assert.match(beginning, /body-line-000/u);
		assert.match(beginning, /Lines 1-11 of \d+ · PageUp\/PageDown review/u);
		assert.match(beginning, /Edit\n {2}Post issue\n {2}Cancel/u);

		component.handleInput("\x1b[6~");
		component.handleInput("\x1b[6~");
		const middleLines = component.render(80);
		const middle = stripAnsi(middleLines.join("\n"));
		assert.ok(middleLines.length <= 18);
		assert.match(middle, /body-line-020/u);
		assert.match(middle, /Edit\n {2}Post issue\n {2}Cancel/u);
		assert.deepEqual(actions, []);

		for (let page = 0; page < 20; page += 1) component.handleInput("\x1b[6~");
		const endLines = component.render(80);
		const end = stripAnsi(endLines.join("\n"));
		assert.ok(endLines.length <= 18);
		component.handleInput("\x1b[5~");
		const bodyEnd = stripAnsi(component.render(80).join("\n"));
		assert.match(bodyEnd, /body-line-044/u);
		component.handleInput("\x1b[6~");
		assert.match(end, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
		assert.match(end, /title: home-directory prefix replaced with ~/u);
		assert.match(end, /body: API or access token redacted/u);
		assert.match(end, /Lines \d+-\d+ of \d+ · PageUp\/PageDown review/u);
		assert.match(end, /Edit\n {2}Post issue\n {2}Cancel/u);
		assert.deepEqual(actions, []);
		assert.ok(endLines.every((line) => visibleWidth(line) <= 80));

		component.handleInput("\x1b[5~");
		assert.deepEqual(actions, []);
		component.handleInput("\t");
		component.handleInput("\r");
		assert.deepEqual(actions, ["post"]);
	});

	test("shows Retry, Copy, Cancel in order after failure and Escape cancels", () => {
		const actions: string[] = [];
		const component = new FeedbackFailureComponent("Authentication required", plainTheme, (action) =>
			actions.push(action),
		);
		const rendered = stripAnsi(component.render(32).join("\n"));
		assert.ok(rendered.indexOf("Retry") < rendered.indexOf("Copy"));
		assert.ok(rendered.indexOf("Copy") < rendered.indexOf("Cancel"));
		component.handleInput("\x1b");
		assert.deepEqual(actions, ["cancel"]);
	});
});

describe("feedback submission state", () => {
	test("locks duplicate submissions and returns a URL only after genuine success", async () => {
		let calls = 0;
		let finish: ((value: { status: "success"; url: string }) => void) | undefined;
		const post: FeedbackPostHandler = async () => {
			calls += 1;
			return await new Promise((resolve) => {
				finish = resolve;
			});
		};
		const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "request-1");

		const first = controller.submit(post);
		const duplicate = controller.submit(post);
		assert.equal(calls, 1);
		assert.equal(controller.state, "submitting");
		finish?.({ status: "success", url: "https://github.com/bastani-inc/atomic/issues/999999" });
		assert.deepEqual(await first, { status: "posted", url: "https://github.com/bastani-inc/atomic/issues/999999" });
		assert.deepEqual(await duplicate, {
			status: "posted",
			url: "https://github.com/bastani-inc/atomic/issues/999999",
		});
		assert.equal(controller.state, "posted");
		assert.deepEqual(
			controller.preview.replacements.slice(0, 2).map((replacement) => replacement.kind),
			["home-directory", "api-token"],
		);
	});

	test("keeps only current replacement provenance across repeated edits in title-then-body order", () => {
		// #2799: edits must drop removed disclosures, preserve surviving placeholders, and never accumulate duplicates.
		const initial = scrubFeedbackDraft(
			{
				repository: "bastani-inc/atomic",
				kind: "bug",
				label: "bug",
				title: "/synthetic/home/Crash after paste",
				body: "## What happened?\n\nTOKEN=synthetic-secret-value\n\n## Steps to reproduce\n\nPaste text\n\n## Non-builtin extensions\n\nInactive\n\n## Extension-free reproduction\n\nNot tested without extensions",
			},
			{ homeDirectories: ["/synthetic/home"] },
		);
		const controller = new FeedbackSubmissionController(initial, () => "request-edit");
		controller.beginEdit();
		controller.applyEdit({
			title: "Edited ghp_abcdefghijklmnopqrstuvwxyz",
			body: `${controller.preview.draft.body}\n\nghp_zyxwvutsrqponmlkjihgfedcba`,
		});

		assert.equal(controller.state, "preview");
		assert.doesNotMatch(controller.preview.draft.title, /ghp_/u);
		assert.doesNotMatch(controller.preview.draft.body, /synthetic-secret-value|ghp_/u);
		assert.match(controller.preview.draft.body, /TOKEN=\[REDACTED\]/u);
		assert.deepEqual(
			controller.preview.replacements.map(({ field, kind }) => ({ field, kind })),
			[
				{ field: "title", kind: "api-token" },
				{ field: "body", kind: "credential-assignment" },
				{ field: "body", kind: "api-token" },
			],
		);

		const once = controller.preview.replacements.map(({ field, kind, description }) => ({
			field,
			kind,
			description,
		}));
		controller.beginEdit();
		controller.applyEdit({ title: controller.preview.draft.title, body: controller.preview.draft.body });
		assert.deepEqual(
			controller.preview.replacements.map(({ field, kind, description }) => ({ field, kind, description })),
			once,
		);
	});

	test("retains the complete draft on thrown, failed, and malformed post outcomes and reuses the request id on retry", async () => {
		for (const post of [
			async () => {
				throw new Error("synthetic failure");
			},
			async () => ({ status: "failure" as const, message: "Authentication required" }),
			async () => ({ status: "success" as const, url: "not-an-issue-url" }),
		]) {
			const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "stable-request");
			const original = controller.preview;
			const failed = await controller.submit(post);
			assert.equal(failed.status, "failed");
			assert.equal(controller.state, "failed");
			assert.equal(controller.preview, original);

			let retryRequestId = "";
			const posted = await controller.submit(async (request) => {
				retryRequestId = request.requestId;
				return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999998" };
			});
			assert.equal(retryRequestId, "stable-request");
			assert.equal(posted.status, "posted");
		}
	});

	test("resumes an uncertain request after Cancel with the same controller, draft, and reconciliation identity", async () => {
		// #2799: dismissing uncertain failure UI must not make its retained request terminal.
		const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "uncertain-request");
		const preview = controller.preview;
		const requestIds: string[] = [];
		const uncertain = await controller.submit(async (request) => {
			requestIds.push(request.requestId);
			return {
				status: "uncertain",
				message: "GitHub may have created this issue. Retry must reconcile first.",
			};
		});

		assert.deepEqual(uncertain, {
			status: "failed",
			message: "GitHub may have created this issue. Retry must reconcile first.",
			uncertain: true,
		});
		controller.cancel();
		assert.equal(controller.state, "retained");
		assert.equal(controller.creationUncertain, true);
		assert.equal(controller.requestId, "uncertain-request");
		assert.equal(controller.preview, preview);

		const posted = await controller.submit(async (request) => {
			requestIds.push(request.requestId);
			assert.equal(request.draft, preview.draft);
			return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999992" };
		});
		assert.deepEqual(posted, {
			status: "posted",
			url: "https://github.com/bastani-inc/atomic/issues/999992",
		});
		assert.deepEqual(requestIds, ["uncertain-request", "uncertain-request"]);
	});

	test("keeps uncertainty sticky across a later transport failure until reconciliation succeeds", async () => {
		const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "sticky-uncertain-request");
		await controller.submit(async () => ({ status: "uncertain", message: "Reconcile before retry." }));
		const failed = await controller.submit(async () => ({
			status: "failure",
			message: "Authentication unavailable.",
		}));

		assert.deepEqual(failed, {
			status: "failed",
			message: "Authentication unavailable.",
			uncertain: true,
		});
		assert.equal(controller.creationUncertain, true);
		controller.cancel();
		assert.equal(controller.state, "retained");
	});

	test("retries an uncertain request with the same reconciliation identity", async () => {
		const controller = new FeedbackSubmissionController(scrubbedDraft(), () => "reconcile-request");
		const requestIds: string[] = [];
		const post: FeedbackPostHandler = async (request) => {
			requestIds.push(request.requestId);
			return requestIds.length === 1
				? { status: "uncertain", message: "Reconcile before retry." }
				: { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999993" };
		};

		assert.equal((await controller.submit(post)).status, "failed");
		assert.equal((await controller.submit(post)).status, "posted");
		assert.deepEqual(requestIds, ["reconcile-request", "reconcile-request"]);
	});

	test("rejects illegal transitions without invoking the posting seam", async () => {
		let posts = 0;
		const post: FeedbackPostHandler = async () => {
			posts += 1;
			return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999994" };
		};
		const cancelled = new FeedbackSubmissionController(scrubbedDraft(), () => "cancelled-request");
		cancelled.cancel();
		assert.throws(() => cancelled.submit(post), FeedbackSubmissionTransitionError);
		assert.throws(() => cancelled.beginEdit(), FeedbackSubmissionTransitionError);

		const editing = new FeedbackSubmissionController(scrubbedDraft(), () => "editing-request");
		editing.beginEdit();
		assert.throws(() => editing.submit(post), FeedbackSubmissionTransitionError);
		assert.throws(
			() => editing.applyEdit({ title: "", body: editing.preview.draft.body }),
			/Missing required feedback fields: title/,
		);
		assert.equal(editing.state, "editing");
		editing.cancel();
		assert.equal(editing.state, "cancelled");
		assert.equal(posts, 0);
	});
});
