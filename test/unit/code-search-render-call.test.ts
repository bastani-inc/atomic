import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { ProcessTerminal, TuiMainScreen } from "@bastani/atomic-tui";
import { test } from "vitest";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

initTheme("dark", false);

async function codeSearchTool() {
	const { default: webAccess } = (await import(
		new URL("../../packages/web-access/index.ts", import.meta.url).href
	)) as { default: (atomic: ExtensionAPI) => void };
	const tools = new Map<string, ToolDefinition>();
	webAccess({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on() {
			return () => {};
		},
		registerShortcut() {},
		registerCommand() {},
	} as Pick<ExtensionAPI, "registerTool" | "on" | "registerShortcut" | "registerCommand"> as ExtensionAPI);
	const tool = tools.get("code_search");
	assert.ok(tool);
	return tool;
}

test("code_search identifies its repository and query before execution or any result", async () => {
	const tool = await codeSearchTool();
	assert.ok(tool.renderCall);
	const args = { repoName: "Owner/Repo.name", query: "Explain entry points" };
	const component = tool.renderCall(args, theme, {} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2]);
	const text = component.render(80).join("\n");
	assert.ok(text.includes(args.repoName));
	assert.ok(text.includes(args.query));
});

test("code_search safely renders streaming arguments and preserves supplied text", async () => {
	const tool = await codeSearchTool();
	assert.ok(tool.renderCall);
	for (const args of [
		undefined,
		null,
		{},
		{ query: "question" },
		{ repoName: "Owner/" },
		{ repoName: "", query: "" },
		{ repoName: "Owner/Repo", query: "  question\nsecond line" },
	]) {
		const text = stripVTControlCharacters(
			tool
				.renderCall(args, theme, {} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2])
				.render(120)
				.join("\n"),
		);
		assert.ok(text.includes("code_search"));
		if (args?.repoName) assert.ok(text.includes(args.repoName));
		if (args?.query) for (const line of args.query.split("\n")) assert.ok(text.includes(line));
		assert.ok(!text.includes("undefined"));
	}
});

test("code_search host row keeps repository visible through pending, completion and error", async () => {
	const tool = await codeSearchTool();
	const ui = new TuiMainScreen(new ProcessTerminal());
	const row = new ToolExecutionComponent("code_search", "repo-label", {}, {}, tool, ui, process.cwd());
	const render = () => stripVTControlCharacters(row.render(80).join("\n"));
	assert.ok(render().includes("code_search"));
	row.updateArgs({ repoName: "Owner/Repo" });
	assert.ok(render().includes("Owner/Repo"));
	row.updateArgs({ repoName: "Owner/Repo", query: "Explain entry points" });
	row.setArgsComplete();
	row.markExecutionStarted();
	assert.ok(render().includes("Owner/Repo"));
	assert.ok(render().includes("Explain entry points"));
	row.updateResult({
		content: [{ type: "text", text: "Fixture answer" }],
		details: { maxTokens: 1000 },
		isError: false,
	});
	assert.ok(render().includes("Owner/Repo"));
	assert.ok(render().includes("DeepWiki answer returned"));
	row.setExpanded(true);
	assert.ok(render().includes("Fixture answer"));
	row.updateResult({
		content: [{ type: "text", text: "Unavailable" }],
		details: { error: "Unavailable" },
		isError: true,
	});
	assert.ok(render().includes("Owner/Repo"));
	assert.ok(render().includes("✗"));
	assert.ok(render().includes("Unavailable"));
});
