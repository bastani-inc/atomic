import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { parseHTML } from "linkedom";
import { test } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	buildQuestionnaireResponse,
	createAskUserQuestionToolDefinition,
} from "../src/core/tools/ask-user-question/ask-user-question.ts";
import type { QuestionParams } from "../src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

test("HTML exports retain a questionnaire answer folded into its call line (#5244)", async () => {
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
		const tool = createAskUserQuestionToolDefinition();
		const session = SessionManager.inMemory(dir);
		await session.appendMessage(
			fauxAssistantMessage([fauxToolCall("ask_user_question", params, { id: "question-call" })], {
				stopReason: "toolUse",
			}),
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
		const output = await exportSessionToHtml(session, undefined, {
			outputPath: join(dir, "export.html"),
			toolRenderer: createToolHtmlRenderer({ getToolRenderers: () => tool, theme, cwd: dir }),
		});
		const encoded = parseHTML(readFileSync(output, "utf8")).document.getElementById("session-data")?.textContent;
		assert.ok(encoded);
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
			renderedTools: Record<string, { callHtml?: string; resultHtmlExpanded?: string }>;
		};
		assert.match(data.renderedTools["question-call"]?.callHtml ?? "", /Navigation.*Build it as shown/);
		assert.equal(data.renderedTools["question-call"]?.resultHtmlExpanded, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
