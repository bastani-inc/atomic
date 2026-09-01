import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/index.ts";
import type { FeedbackSessionFacts } from "../src/extensions/feedback/index.ts";
import { FeedbackInvestigationController } from "../src/extensions/feedback/investigation.ts";
import {
	createFeedbackSubmissionTool,
	type FeedbackSubmissionToolDetails,
	prepareFeedbackSubmission,
	runFeedbackInteraction,
} from "../src/extensions/feedback/submission.ts";

function facts(): FeedbackSessionFacts {
	return {
		version: "1.2.3-alpha.4",
		platform: "darwin",
		architecture: "arm64",
		runtime: "Bun 1.4.0",
		mode: "tui",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		nonBuiltinExtensionsLoaded: false,
		recentFailedOutcomes: [],
		sessionErrorState: "none",
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function enhancementPreview() {
	return prepareFeedbackSubmission(
		{
			kind: "enhancement",
			title: "Keyboard hints",
			whatToChange: "Show the shortcuts.",
			why: "Users should discover the controls.",
		},
		{ status: "not-required", prompt: "add keyboard hints", nonBuiltinExtensionsLoaded: false },
	);
}

function postingContext(rendered: string[]): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory) =>
				await new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {} } as never,
						plainTheme as never,
						{} as never,
						resolve,
					);
					rendered.push(...component.render(80));
					for (let page = 0; page < 20; page += 1) {
						component.handleInput?.("\x1b[6~");
						rendered.push(...component.render(80));
					}
					component.handleInput?.("\x1b[B");
					component.handleInput?.("\r");
				}),
			notify: () => {},
			setEditorText: () => {},
		} as ExtensionContext["ui"],
	} as ExtensionContext;
}

describe("feedback submission tool", () => {
	test("owns the exact reviewed payload and returns the URL only after explicit Post issue", async () => {
		const rendered: string[] = [];
		const requests: Array<{ requestId: string; title: string; body: string }> = [];
		const investigation = new FeedbackInvestigationController({
			prompt: "add keyboard hints",
			facts: facts(),
			debuggerToolAvailable: true,
		});
		const tool = createFeedbackSubmissionTool({
			getInvestigation: () => investigation,
			post: async (request) => {
				requests.push({ requestId: request.requestId, title: request.draft.title, body: request.draft.body });
				return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999997" };
			},
			createRequestId: () => "request-tool",
			onTerminal: () => {},
		});
		assert.equal(tool.name, "submit_feedback");

		const result = await tool.execute(
			"call-1",
			{
				kind: "enhancement",
				title: "Keyboard hints",
				whatToChange: "Show the shortcuts.",
				why: "Users should discover the controls.",
			},
			undefined,
			undefined,
			postingContext(rendered),
		);

		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0], {
			requestId: "request-tool",
			title: "Keyboard hints",
			body: "## What do you want to change?\n\nShow the shortcuts.\n\n## Why?\n\nUsers should discover the controls.\n\n<!-- atomic-feedback-request:request-tool;kind:enhancement -->",
		});
		assert.match(rendered.join("\n"), /atomic-feedback-request:request-tool;kind:enhancement/u);
		assert.equal(result.content[0]?.type, "text");
		assert.equal(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			"https://github.com/bastani-inc/atomic/issues/999997",
		);
		const details = result.details as FeedbackSubmissionToolDetails;
		assert.equal(details.status, "posted");
		assert.equal(details.url, "https://github.com/bastani-inc/atomic/issues/999997");
		assert.match(rendered.join("\n"), /Repository\s+bastani-inc\/atomic/);
	});
	test("routes Edit through validation and scrubbing and posts the last confirmed preview", async () => {
		let previewCount = 0;
		let postedTitle = "";
		let postedBody = "";
		const investigation = new FeedbackInvestigationController({
			prompt: "add keyboard hints",
			facts: facts(),
			debuggerToolAvailable: true,
		});
		const tool = createFeedbackSubmissionTool({
			getInvestigation: () => investigation,
			post: async (request) => {
				postedTitle = request.draft.title;
				postedBody = request.draft.body;
				return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999996" };
			},
			createRequestId: () => "request-edit",
			onTerminal: () => {},
		});
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
					await new Promise((resolve) => {
						const component = factory(
							{ requestRender: () => {} } as never,
							plainTheme as never,
							{} as never,
							resolve,
						);
						if (previewCount++ > 0) component.handleInput?.("\x1b[B");
						component.handleInput?.("\r");
					}),
				hostInputForm: async () => ({
					title: "Edited title",
					body: "## What do you want to change?\n\nEdited change TOKEN=synthetic-secret-value\n\n## Why?\n\nEdited reason",
				}),
				notify: () => {},
				setEditorText: () => {},
			} as ExtensionContext["ui"],
		} as ExtensionContext;

		await tool.execute(
			"call-edit",
			{
				kind: "enhancement",
				title: "Original",
				whatToChange: "Original change",
				why: "Original reason",
			},
			undefined,
			undefined,
			context,
		);

		assert.equal(postedTitle, "Edited title");
		assert.match(postedBody, /Edited change TOKEN=\[REDACTED\]/);
		assert.doesNotMatch(postedBody, /synthetic-secret-value/);
		assert.equal(postedBody.split("<!-- atomic-feedback-request:").length - 1, 1);
		assert.match(postedBody, /<!-- atomic-feedback-request:request-edit;kind:enhancement -->$/u);
	});

	test("cancels from preview and edit without calling the posting seam", async () => {
		for (const path of ["preview", "edit"] as const) {
			let posts = 0;
			const context = {
				mode: "tui",
				hasUI: true,
				ui: {
					custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
						await new Promise((resolve) => {
							const component = factory(
								{ requestRender: () => {} } as never,
								plainTheme as never,
								{} as never,
								resolve,
							);
							component.handleInput?.(path === "preview" ? "\x1b" : "\r");
						}),
					hostInputForm: async () => undefined,
					notify: () => {},
					setEditorText: () => {},
				} as ExtensionContext["ui"],
			} as ExtensionContext;
			const outcome = await runFeedbackInteraction(context, enhancementPreview(), async () => {
				posts += 1;
				return { status: "failure", message: "must not run" };
			});
			assert.equal(outcome.status, "cancelled");
			assert.equal(posts, 0);
		}
	});

	test("offers Retry, Copy, Cancel after failure and copies the complete retained draft to the editor", async () => {
		let customCalls = 0;
		let editorText = "";
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
					await new Promise((resolve) => {
						const component = factory(
							{ requestRender: () => {} } as never,
							plainTheme as never,
							{} as never,
							resolve,
						);
						component.handleInput?.("\x1b[B");
						component.handleInput?.("\r");
						customCalls += 1;
					}),
				notify: () => {},
				setEditorText: (value: string) => {
					editorText = value;
				},
			} as ExtensionContext["ui"],
		} as ExtensionContext;
		const outcome = await runFeedbackInteraction(context, enhancementPreview(), async () => ({
			status: "failure",
			message: "Authentication required",
		}));

		assert.equal(customCalls, 2);
		assert.equal(outcome.status, "retained");
		assert.equal(editorText, `${outcome.preview.draft.title}\n\n${outcome.preview.draft.body}`);
		assert.equal(outcome.url, undefined);
	});

	test("cancels from retained posting failure without retrying or creating another issue", async () => {
		let posts = 0;
		let customCalls = 0;
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
					await new Promise((resolve) => {
						const component = factory(
							{ requestRender: () => {} } as never,
							plainTheme as never,
							{} as never,
							resolve,
						);
						if (customCalls === 0) {
							component.handleInput?.("\x1b[B");
							component.handleInput?.("\r");
						} else {
							component.handleInput?.("\x1b");
						}
						customCalls += 1;
					}),
				notify: () => {},
				setEditorText: () => {},
			} as ExtensionContext["ui"],
		} as ExtensionContext;
		const outcome = await runFeedbackInteraction(context, enhancementPreview(), async () => {
			posts += 1;
			return { status: "failure", message: "Authentication required" };
		});

		assert.equal(outcome.status, "cancelled");
		assert.equal(customCalls, 2);
		assert.equal(posts, 1);
		assert.equal(outcome.url, undefined);
	});

	test("retains the scrubbed draft without opening UI in non-interactive mode", async () => {
		let posts = 0;
		const outcome = await runFeedbackInteraction(
			{ mode: "json", hasUI: false, ui: {} as ExtensionContext["ui"] } as ExtensionContext,
			enhancementPreview(),
			async () => {
				posts += 1;
				return { status: "success", url: "https://github.com/bastani-inc/atomic/issues/999995" };
			},
		);
		assert.equal(outcome.status, "retained");
		assert.equal(posts, 0);
		assert.equal(outcome.url, undefined);
	});

	test("assesses bug investigation before preview and discloses honest degradation and working-tree state", async () => {
		const rendered: string[] = [];
		const investigation = new FeedbackInvestigationController({
			prompt: "bug report",
			facts: facts(),
			debuggerToolAvailable: false,
		});
		investigation.setWorkingTreeDisclosure({
			status: "changed",
			preExistingChangesPreserved: true,
			artifacts: [{ path: "diagnostics/report.log", status: "??", change: "created" }],
		});
		const tool = createFeedbackSubmissionTool({
			getInvestigation: () => investigation,
			post: async () => ({ status: "failure", message: "must not run" }),
			onTerminal: () => {},
		});
		const context = postingContext(rendered);
		context.ui.custom = async (factory) =>
			await new Promise((resolve) => {
				const component = factory({ requestRender: () => {} } as never, plainTheme as never, {} as never, resolve);
				rendered.push(...component.render(100));
				for (let page = 0; page < 20; page += 1) {
					component.handleInput?.("\x1b[6~");
					rendered.push(...component.render(100));
				}
				component.handleInput?.("\x1b");
			});

		const result = await tool.execute(
			"bug-call",
			{
				kind: "bug",
				title: "Bug",
				whatHappened: "Observed",
				stepsToReproduce: "Run it",
				nonBuiltinExtensionState: "inactive",
				extensionFreeReproduction: "unknown",
			},
			undefined,
			undefined,
			context,
		);
		const details = result.details as FeedbackSubmissionToolDetails;
		assert.equal(details.status, "cancelled");
		assert.match(details.draft.body, /## Investigation\n\nInvestigation unavailable/);
		assert.match(details.draft.body, /diagnostics\/report\.log/);
		assert.match(rendered.join("\n"), /Not tested without extensions/);
	});

	test("derives active third-party extension state from captured session facts, not model input", () => {
		// #2799: model input cannot override extension provenance captured at command start.
		const investigation = new FeedbackInvestigationController({
			prompt: "bug report",
			facts: { ...facts(), nonBuiltinExtensionsLoaded: true },
			debuggerToolAvailable: false,
		});
		const preview = prepareFeedbackSubmission(
			{
				kind: "bug",
				title: "Bug",
				whatHappened: "Observed",
				stepsToReproduce: "Run it",
				nonBuiltinExtensionState: "inactive",
				extensionFreeReproduction: "unknown",
			},
			investigation.assess("bug"),
		);

		assert.match(preview.draft.body, /## Non-builtin extensions\n\nActive/u);
		assert.doesNotMatch(preview.draft.body, /## Non-builtin extensions\n\nInactive/u);
	});

	test("derives builtin-only extension state from captured session facts, not model input", () => {
		const investigation = new FeedbackInvestigationController({
			prompt: "bug report",
			facts: { ...facts(), nonBuiltinExtensionsLoaded: false },
			debuggerToolAvailable: false,
		});
		const preview = prepareFeedbackSubmission(
			{
				kind: "bug",
				title: "Bug",
				whatHappened: "Observed",
				stepsToReproduce: "Run it",
				nonBuiltinExtensionState: "active",
				extensionFreeReproduction: "unknown",
			},
			investigation.assess("bug"),
		);

		assert.match(preview.draft.body, /## Non-builtin extensions\n\nInactive/u);
		assert.doesNotMatch(preview.draft.body, /## Non-builtin extensions\n\nActive/u);
	});

	test("rejects missing required structured fields before preview or posting", async () => {
		let posts = 0;
		let previews = 0;
		const investigation = new FeedbackInvestigationController({
			prompt: "bug report",
			facts: facts(),
			debuggerToolAvailable: false,
		});
		const tool = createFeedbackSubmissionTool({
			getInvestigation: () => investigation,
			post: async () => {
				posts += 1;
				return { status: "failure", message: "must not run" };
			},
			onTerminal: () => {},
		});
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async () => {
					previews += 1;
					return undefined;
				},
			} as ExtensionContext["ui"],
		} as ExtensionContext;
		await assert.rejects(
			tool.execute(
				"invalid-call",
				{ kind: "bug", title: "Bug", nonBuiltinExtensionState: "inactive", extensionFreeReproduction: "unknown" },
				undefined,
				undefined,
				context,
			),
			/Missing required feedback fields: What happened\?, Steps to reproduce/,
		);
		assert.equal(previews, 0);
		assert.equal(posts, 0);
	});
});
