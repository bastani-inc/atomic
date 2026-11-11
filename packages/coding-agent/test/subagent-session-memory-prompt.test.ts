import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { SubagentChildPolicy, ToolDefinition } from "../src/core/extensions/index.js";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

const AGENT_PROMPT = "You are the recall agent. Report what the project did before.";
const SUBAGENT: SubagentChildPolicy = {
	managementActions: "restricted",
	fanoutAuthorized: false,
	inheritProjectContext: false,
	inheritSkills: false,
	depth: 1,
};

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

async function systemPrompt(options: HarnessOptions): Promise<string> {
	const harness = await createHarness(options);
	harnesses.push(harness);
	return harness.session.systemPrompt;
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

describe("Session memory in a subagent's own prompt (#4648)", () => {
	test("a subagent whose own prompt replaces the default keeps Session memory as a section of its own (#4648)", async () => {
		const prompt = await systemPrompt({
			subagentPolicy: SUBAGENT,
			resourceLoader: createTestResourceLoader({ systemPrompt: AGENT_PROMPT }),
		});

		assert.ok(prompt.startsWith(AGENT_PROMPT), prompt);
		assert.ok(!prompt.includes("Guidelines:"), "the agent's prompt still replaces the default rules");
		const section = prompt.slice(prompt.indexOf("<session_memory>\n"), prompt.indexOf("</session_memory>"));
		assert.ok(section.startsWith("<session_memory>\n- **Session memory**: Atomic records past sessions"), section);
		assert.ok(section.includes("`read history://sessions` and `read history://workflows`"), section);
		assert.ok(section.includes("`search` accepts the same URLs"), section);
		assert.ok(section.includes("With a shell, also search the repository's source control"), section);
	});

	test("follows the subagent's tools, and is left out without read (#4648)", async () => {
		const readOnly = await systemPrompt({
			subagentPolicy: SUBAGENT,
			resourceLoader: createTestResourceLoader({ systemPrompt: AGENT_PROMPT }),
			initialActiveToolNames: ["read"],
		});
		const withoutRead = await systemPrompt({
			subagentPolicy: SUBAGENT,
			resourceLoader: createTestResourceLoader({ systemPrompt: AGENT_PROMPT }),
			initialActiveToolNames: ["bash", "search"],
		});

		assert.ok(readOnly.includes("<session_memory>\n- **Session memory**"), readOnly);
		assert.ok(!readOnly.includes("`search` accepts the same URLs"), readOnly);
		assert.ok(!readOnly.includes("source control"), readOnly);
		assert.ok(!withoutRead.includes("**Session memory**"), withoutRead);
	});

	test("is left out when the subagent's read declaration is hidden (#4648)", async () => {
		const hidesRead: ToolDefinition = {
			name: "hides_read",
			label: "Hides read",
			description: "Hides the read declaration",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
			prepareLoadout: () => ({ hiddenDeclarations: ["read"] }),
		};
		const prompt = await systemPrompt({
			subagentPolicy: SUBAGENT,
			resourceLoader: createTestResourceLoader({ systemPrompt: AGENT_PROMPT }),
			customTools: [hidesRead],
		});

		assert.ok(prompt.startsWith(AGENT_PROMPT), prompt);
		assert.ok(!prompt.includes("**Session memory**"), prompt);
	});

	test("a subagent on the default prompt has Session memory once, among its rules (#4648)", async () => {
		const prompt = await systemPrompt({ subagentPolicy: SUBAGENT });

		assert.equal(occurrences(prompt, "**Session memory**"), 1, prompt);
		assert.ok(!prompt.includes("<session_memory>"), prompt);
		assert.ok(prompt.indexOf("**Session memory**") > prompt.indexOf("Guidelines:"), prompt);
	});

	test("a main session whose own prompt replaces the default gets no Session memory section (#4648)", async () => {
		const prompt = await systemPrompt({ resourceLoader: createTestResourceLoader({ systemPrompt: AGENT_PROMPT }) });

		assert.ok(prompt.startsWith(AGENT_PROMPT), prompt);
		assert.ok(!prompt.includes("**Session memory**"), prompt);
	});
});
