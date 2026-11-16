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
		assert.doesNotMatch(questionExecution.textContent ?? "", /User has answered your questions:/);
		assert.equal(questionExecution.querySelector(".tool-output"), null);

		const declinedExecution = document.getElementById("tool-call-declined-call");
		assert.ok(declinedExecution);
		assert.match(declinedExecution.textContent ?? "", /Declined · Nav \(Build \/ Skip\)/);
		assert.doesNotMatch(declinedExecution.textContent ?? "", /User declined to answer questions/);
		assert.equal(declinedExecution.querySelector(".tool-output"), null);

		const answeredCtrlExecution = document.getElementById("tool-call-answered-ctrl-call");
		assert.ok(answeredCtrlExecution);
		assert.match(answeredCtrlExecution.textContent ?? "", /Nav → Typed · notes: note!/);
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
