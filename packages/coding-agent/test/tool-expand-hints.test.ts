import { join } from "node:path";
import { getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousKeybindings = getKeybindings();

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function component(name: string, args: object, definition: ToolDefinition): ToolExecutionComponent {
	const result = new ToolExecutionComponent(name, `${name}-call`, args, {}, definition, fakeTui(), process.cwd());
	result.markExecutionStarted();
	result.setArgsComplete();
	return result;
}

function updateWithLines(target: ToolExecutionComponent, count: number): void {
	target.updateResult({
		content: [{ type: "text", text: Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") }],
		details: {},
		isError: false,
	}, false);
}

function visible(target: ToolExecutionComponent): string {
	return stripAnsi(target.render(120).join("\n"));
}

function expectNoUnavailableExpandHint(text: string): void {
	expect(text).not.toMatch(/\(\s*(?:Expand|Collapse|to expand)\s*\)/);
	expect(text).not.toMatch(/,\s*\)/);
	expect(text).not.toMatch(/\b(?:Expand|Collapse)\b/);
}

beforeAll(() => initTheme("dark"));

afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("unbound tool expansion hints", () => {
	test("omits the whole affordance on collapsed skill, resource, and docs reads", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		for (const scenario of [
			{ path: join(process.cwd(), "tmux", "SKILL.md"), expected: "[skill] tmux", body: "skill body" },
			{ path: join(process.cwd(), ".atomic", "AGENTS.md"), expected: "read resource .atomic/AGENTS.md", body: "resource body" },
			{ path: getReadmePath(), expected: "read docs README.md", body: "docs body" },
		]) {
			const target = component("read", { path: scenario.path }, createReadToolDefinition(process.cwd()));
			target.updateResult({ content: [{ type: "text", text: scenario.body }], details: {}, isError: false }, false);
			const collapsed = visible(target);
			expect(collapsed).toContain(scenario.expected);
			expect(collapsed).not.toContain(scenario.body);
			expectNoUnavailableExpandHint(collapsed);

			target.setExpanded(true);
			expect(visible(target)).toContain(scenario.body);
		}
	});

	test("keeps built-in truncation facts without dangling expand punctuation", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const definitions: Array<{ name: string; args: object; definition: ToolDefinition; lines: number }> = [
			{ name: "bash", args: { command: "printf output" }, definition: createBashToolDefinition(process.cwd()), lines: 8 },
			{ name: "find", args: { paths: ["."] }, definition: createFindToolDefinition(process.cwd()), lines: 23 },
			{ name: "grep", args: { pattern: "line" }, definition: createGrepToolDefinition(process.cwd()), lines: 18 },
			{ name: "ls", args: { path: "." }, definition: createLsToolDefinition(process.cwd()), lines: 23 },
		];
		for (const scenario of definitions) {
			const target = component(scenario.name, scenario.args, scenario.definition);
			updateWithLines(target, scenario.lines);
			const rendered = visible(target);
			expect(rendered).toMatch(/earlier lines|more lines/);
			expectNoUnavailableExpandHint(rendered);
		}

		const write = component("write", {
			path: "output.ts",
			content: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
		}, createWriteToolDefinition(process.cwd()));
		const renderedWrite = visible(write);
		expect(renderedWrite).toContain("2 more lines, 12 total");
		expectNoUnavailableExpandHint(renderedWrite);
	});
});
