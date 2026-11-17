import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { parseHTML } from "linkedom";
import { test } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	buildQuestionnaireResponse,
	createAskUserQuestionToolDefinition,
} from "../src/core/tools/ask-user-question/ask-user-question.ts";
import type { QuestionParams } from "../src/core/tools/ask-user-question/tool/types.ts";
import { ToolBlock, ToolBlockGroup, ToolBlockRecords } from "../src/modes/interactive/components/tool-block.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function renderExportedDocument(htmlPath: string) {
	const rawHtml = readFileSync(htmlPath, "utf8");
	const { window, document } = parseHTML(rawHtml);
	Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
	const location = { search: "", hash: "" };
	Object.defineProperty(window, "location", { configurable: true, value: location });
	const context = {
		window,
		document,
		atob,
		TextDecoder,
		URLSearchParams,
		console,
		navigator: { clipboard: undefined },
		location,
		history: { replaceState: () => undefined },
		localStorage: { getItem: () => null, setItem: () => undefined },
		matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
		requestAnimationFrame: (callback: () => void) => {
			callback();
			return 0;
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined,
	};
	for (const script of document.querySelectorAll("script")) {
		if (script.getAttribute("type") === "application/json") continue;
		runInNewContext(script.textContent ?? "", context);
	}
	return { rawHtml, document };
}

test("HTML exports retain folded questionnaire summaries without duplicating raw envelopes or leaking terminal escapes (#5244)", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "atomic-question-export-"));
	try {
		const params: QuestionParams = {
			questions: [
				{
					question: "How should navigation work?",
					header: "Navigation",
					options: [
						{ label: "Build it as shown", description: "Use the approved mockups" },
						{ label: "Simplify", description: "Use fewer controls" },
					],
				},
			],
		};
		const injectedParams: QuestionParams = {
			questions: [
				{
					question: "Pick\x1b]52;c;aGk=\x07 mode?",
					header: "\x1b]52;c;aGk=\x07Nav",
					options: [
						{ label: "Build\x1b[2J", description: "Keep layout" },
						{ label: "Skip\u009b2J", description: "Drop layout" },
					],
				},
			],
		};
		const questionTool = createAskUserQuestionToolDefinition();
		const callOnlyTool: ToolRenderers = {
			renderCall: questionTool.renderCall,
		};
		const session = SessionManager.inMemory(dir);
		await session.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("ask_user_question", params, { id: "question-call" }),
					fauxToolCall("ask_user_question", injectedParams, { id: "declined-call" }),
					fauxToolCall("ask_user_question", injectedParams, { id: "answered-ctrl-call" }),
					fauxToolCall("ask_user_question", injectedParams, { id: "pending-ctrl-call" }),
					fauxToolCall("call_only_tool", params, { id: "call-only-id" }),
					fauxToolCall("plain_tool", { query: "status" }, { id: "plain-id" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "question-call",
			toolName: "ask_user_question",
			...buildQuestionnaireResponse(
				{
					answers: [
						{
							questionIndex: 0,
							question: params.questions[0]!.question,
							kind: "option",
							answer: "Build it as shown",
						},
					],
					cancelled: false,
				},
				params,
			),
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "declined-call",
			toolName: "ask_user_question",
			...buildQuestionnaireResponse(
				{
					answers: [],
					cancelled: true,
				},
				injectedParams,
			),
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "answered-ctrl-call",
			toolName: "ask_user_question",
			...buildQuestionnaireResponse(
				{
					answers: [
						{
							questionIndex: 0,
							question: injectedParams.questions[0]!.question,
							kind: "custom",
							answer: "Typed\x1b[2J",
							notes: "note\x1b]52;c;aGk=\x07!",
						},
					],
					cancelled: false,
				},
				injectedParams,
			),
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "call-only-id",
			toolName: "call_only_tool",
			content: [{ type: "text", text: "Call-only fallback body" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "plain-id",
			toolName: "plain_tool",
			content: [{ type: "text", text: "Plain fallback body" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
		const output = await exportSessionToHtml(session, undefined, {
			outputPath: join(dir, "export.html"),
			toolRenderer: createToolHtmlRenderer({
				getToolRenderers: (name) => {
					if (name === "ask_user_question") return questionTool;
					if (name === "call_only_tool") return callOnlyTool;
					return undefined;
				},
				theme,
				cwd: dir,
			}),
		});
		const { rawHtml, document } = renderExportedDocument(output);
		assert.doesNotMatch(rawHtml, /[\x1b\x07\u009b]/);

		const encoded = document.getElementById("session-data")?.textContent;
		assert.ok(encoded);
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
			renderedTools: Record<
				string,
				{ callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }
			>;
		};
		for (const rendered of Object.values(data.renderedTools)) {
			for (const fragment of [rendered.callHtml, rendered.resultHtmlCollapsed, rendered.resultHtmlExpanded]) {
				assert.doesNotMatch(fragment ?? "", /[\x1b\x07\u009b]/);
			}
		}
		assert.match(data.renderedTools["question-call"]?.callHtml ?? "", /Navigation.*Build it as shown/);
		assert.equal(data.renderedTools["question-call"]?.resultHtmlExpanded, "");

		const messagesHtml = document.getElementById("messages")?.innerHTML ?? "";
		assert.doesNotMatch(messagesHtml, /[\x1b\x07\u009b]/);

		const questionExecution = document.getElementById("tool-call-question-call");
		assert.ok(questionExecution);
		assert.match(questionExecution.textContent ?? "", /Navigation.*Build it as shown/);
		assert.doesNotMatch(questionExecution.textContent ?? "", /Questions · Navigation/);
		assert.doesNotMatch(questionExecution.textContent ?? "", /User has answered your questions:/);
		assert.equal(questionExecution.querySelector(".tool-output"), null);

		const declinedExecution = document.getElementById("tool-call-declined-call");
		assert.ok(declinedExecution);
		assert.match(declinedExecution.textContent ?? "", /Questions cancelled/);
		assert.doesNotMatch(declinedExecution.textContent ?? "", /Questions · Nav/);
		assert.doesNotMatch(declinedExecution.textContent ?? "", /User declined to answer questions/);
		assert.equal(declinedExecution.querySelector(".tool-output"), null);

		const answeredCtrlExecution = document.getElementById("tool-call-answered-ctrl-call");
		assert.ok(answeredCtrlExecution);
		assert.match(answeredCtrlExecution.textContent ?? "", /Nav → "Typed" · notes: note!/);
		assert.doesNotMatch(answeredCtrlExecution.textContent ?? "", /Questions · Nav/);
		assert.doesNotMatch(answeredCtrlExecution.textContent ?? "", /User has answered your questions:/);
		assert.equal(answeredCtrlExecution.querySelector(".tool-output"), null);

		const pendingCtrlExecution = document.getElementById("tool-call-pending-ctrl-call");
		assert.ok(pendingCtrlExecution);
		assert.match(pendingCtrlExecution.textContent ?? "", /Questions · Nav/);
		assert.equal(pendingCtrlExecution.querySelector(".tool-output"), null);

		const callOnlyExecution = document.getElementById("tool-call-call-only-id");
		assert.ok(callOnlyExecution);
		assert.match(callOnlyExecution.textContent ?? "", /Call-only fallback body/);

		const plainExecution = document.getElementById("tool-call-plain-id");
		assert.ok(plainExecution);
		assert.match(plainExecution.textContent ?? "", /Plain fallback body/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("HTML export replaces pending calls with canonical ToolBlock and ToolBlockGroup results at widths 80 and 160 without duplicate headers, HTML injection, or private fallback leaks (#5350)", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "atomic-canonical-export-"));
	try {
		const multiParams: QuestionParams = {
			questions: [
				{
					question: "How should navigation work?",
					header: "Nav <b>tag</b>",
					options: [
						{ label: "Build <script>alert(1)</script>", description: "Use mockups" },
						{ label: "Simplify", description: "Fewer controls" },
					],
				},
				{
					question: "Which scope?",
					header: "Scope",
					options: [
						{ label: "Full", description: "Everything" },
						{ label: "Minimal", description: "Core only" },
					],
				},
			],
		};
		const questionTool = createAskUserQuestionToolDefinition();
		const canonicalGroupTool: ToolRenderers = {
			renderCall: () => new ToolBlock({ status: "running", title: "Pending group call" }),
			renderResult: (_result, options) =>
				new ToolBlockGroup([
					new ToolBlock({
						status: "success",
						title: "Group primary",
						details: new ToolBlockRecords(
							options.expanded
								? ["step 1 <img src=x onerror=alert(1)>", "step 2"]
								: ["step 1 <img src=x onerror=alert(1)>"],
						),
					}),
				]),
		};
		const canonicalPendingTool: ToolRenderers = {
			renderCall: () =>
				new ToolBlockGroup([
					new ToolBlock({ status: "running", title: "Canonical pending call", args: "<svg onload=alert(1)>" }),
				]),
		};
		const privateThrowingTool: ToolRenderers = {
			renderCall: () => {
				throw new Error("call formatter exploded: secret-call-detail");
			},
			renderResult: () => {
				throw new Error("result formatter exploded: secret-result-detail");
			},
		};

		for (const width of [80, 160]) {
			const session = SessionManager.inMemory(dir);
			await session.appendMessage(
				fauxAssistantMessage(
					[
						fauxToolCall("ask_user_question", multiParams, { id: "multi-question-call" }),
						fauxToolCall("canonical_group", { target: "alpha" }, { id: "group-call" }),
						fauxToolCall("canonical_pending", { target: "beta" }, { id: "pending-block-call" }),
						fauxToolCall("private_tool", { apiKey: "super-secret-arg" }, { id: "private-call" }),
					],
					{ stopReason: "toolUse" },
				),
			);
			await session.appendMessage({
				role: "toolResult",
				toolCallId: "multi-question-call",
				toolName: "ask_user_question",
				...buildQuestionnaireResponse(
					{
						answers: [
							{
								questionIndex: 0,
								question: multiParams.questions[0]!.question,
								kind: "option",
								answer: "Build <script>alert(1)</script>",
							},
							{
								questionIndex: 1,
								question: multiParams.questions[1]!.question,
								kind: "custom",
								answer: "Custom <img src=x onerror=alert(1)>",
							},
						],
						cancelled: false,
					},
					multiParams,
				),
				isError: false,
				timestamp: Date.now(),
			});
			await session.appendMessage({
				role: "toolResult",
				toolCallId: "group-call",
				toolName: "canonical_group",
				content: [
					{ type: "text", text: "retained group text" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				details: {},
				isError: false,
				timestamp: Date.now(),
			});
			await session.appendMessage({
				role: "toolResult",
				toolCallId: "private-call",
				toolName: "private_tool",
				content: [{ type: "text", text: "super-secret-raw-output" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			});

			const output = await exportSessionToHtml(session, undefined, {
				outputPath: join(dir, `export-${width}.html`),
				toolRenderer: createToolHtmlRenderer({
					getToolRenderers: (name) => {
						if (name === "ask_user_question") return questionTool;
						if (name === "canonical_group") return canonicalGroupTool;
						if (name === "canonical_pending") return canonicalPendingTool;
						if (name === "private_tool") return privateThrowingTool;
						return undefined;
					},
					theme,
					cwd: dir,
					width,
				}),
			});
			const { document } = renderExportedDocument(output);

			const multiEl = document.getElementById("tool-call-multi-question-call");
			assert.ok(multiEl);
			const multiText = multiEl.textContent ?? "";
			assert.match(multiText, /Nav <b>tag<\/b> → Build <script>alert\(1\)<\/script>/);
			assert.match(multiText, /⎿\s+Scope → "Custom <img src=x onerror=alert\(1\)>"/);
			assert.doesNotMatch(multiText, /Questions ·/);
			assert.equal(multiEl.querySelector(".tool-output"), null);
			assert.equal(multiEl.querySelector("script"), null);
			assert.equal(multiEl.querySelector("b"), null);
			assert.equal(multiEl.querySelector("img"), null);

			const groupEl = document.getElementById("tool-call-group-call");
			assert.ok(groupEl);
			const groupText = groupEl.textContent ?? "";
			assert.match(groupText, /Group primary/);
			assert.doesNotMatch(groupText, /Pending group call/);
			assert.equal((groupText.match(/Group primary/g) ?? []).length, 1);
			assert.match(groupText, /step 1 <img src=x onerror=alert\(1\)>/);
			assert.match(groupText, /step 2/);
			assert.equal(groupEl.querySelector("img"), null);

			const pendingBlockEl = document.getElementById("tool-call-pending-block-call");
			assert.ok(pendingBlockEl);
			assert.match(pendingBlockEl.textContent ?? "", /Canonical pending call\(<svg onload=alert\(1\)>\)/);
			assert.equal(pendingBlockEl.querySelector("svg"), null);

			const privateEl = document.getElementById("tool-call-private-call");
			assert.ok(privateEl);
			const privateText = privateEl.textContent ?? "";
			assert.match(privateText, /private_tool/);
			assert.match(privateText, /Result renderer failed/);
			assert.doesNotMatch(
				privateText,
				/super-secret-arg|super-secret-raw-output|secret-call-detail|secret-result-detail/,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
