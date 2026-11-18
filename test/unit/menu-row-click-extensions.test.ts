/**
 * One left click runs a row of the lists bundled extensions and first-run setup draw themselves, as moving there and
 * pressing Enter would, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { HuggingFaceModel } from "../../packages/coding-agent/src/extensions/llama/huggingface.js";
import { HuggingFaceSearch } from "../../packages/coding-agent/src/extensions/llama/huggingface-ui.js";
import { McpManagerView } from "../../packages/coding-agent/src/extensions/mcp/ui.js";
import { FirstTimeSetupComponent } from "../../packages/coding-agent/src/modes/interactive/components/first-time-setup.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { AgentBrowser } from "../../packages/subagents/src/tui/agent-browser.js";
import { flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function session(id: string, name: string): SessionInfo {
	return { id, name, cwd: "/workspace/project", model: "test-model", pid: 1234, startedAt: 1, lastActivity: 2 };
}

for (const width of [80, 160]) {
	test(`a click on a session in the intercom list picks it, name or path line, at ${width} columns`, async () => {
		for (const line of [/reviewer \(/, /workspace\/project • test-model/]) {
			const ui = makeClickScreen(width, 40);
			const picked: Array<string | undefined> = [];
			const others = [session("b-1", "worker"), session("c-2", "reviewer"), session("d-3", "tester")];
			ui.mount(
				new SessionListOverlay(theme, new KeybindingsManager(), session("a-0", "planner"), others, (chosen) =>
					picked.push(chosen?.name),
				),
			);
			// The path line is the same for every session: click the one under the reviewer's name.
			const row = line.source.startsWith("reviewer") ? ui.rowOf(line) : ui.rowOf(/reviewer \(/) + 1;
			await ui.clickAt(ui.columnOf(row, line.source.startsWith("reviewer") ? "reviewer" : "workspace"), row);
			assert.deepEqual(picked, ["reviewer"], ui.screen().join("\n"));
			ui.tui.stop();
		}
	});
}

test("the mouse wheel over the intercom session list moves its selection", async () => {
	const ui = makeClickScreen(100, 40);
	const picked: Array<string | undefined> = [];
	const others = [session("b-1", "worker"), session("c-2", "reviewer")];
	ui.mount(
		new SessionListOverlay(theme, new KeybindingsManager(), session("a-0", "planner"), others, (chosen) =>
			picked.push(chosen?.name),
		),
	);
	await ui.wheel("down", 4, ui.rowOf(/worker \(/));
	ui.terminal.input("\r");
	assert.deepEqual(picked, ["reviewer"]);
	ui.tui.stop();
});

test("a click on a first-run setup option picks it and moves on, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 40);
	const previews: string[] = [];
	const submitted: Array<{ theme: string; shareAnalytics: boolean }> = [];
	ui.dock(
		new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: (name) => previews.push(name),
			onSubmit: (result) => submitted.push(result),
			onCancel: () => {},
		}),
	);
	await ui.click(/Light/, "Light");
	assert.deepEqual(previews, ["light"]);
	assert.ok(ui.rowOf(/Opt in to anonymous usage analytics/) >= 0);
	await ui.click(/Don't share/, "Don't share");
	assert.deepEqual(submitted, [{ theme: "light", shareAnalytics: false }]);
	ui.tui.stop();
});

test("a click on a Hugging Face search result picks that model, and the wheel moves the selection", async () => {
	const ui = makeClickScreen(100, 40);
	const models: HuggingFaceModel[] = [
		{ id: "acme/tiny-GGUF", downloads: 10 },
		{ id: "acme/small-GGUF", downloads: 20 },
		{ id: "acme/large-GGUF", downloads: 30 },
	];
	const cache = new Map([["acme", models]]);
	const picked: Array<string | undefined> = [];
	const search = new HuggingFaceSearch(
		ui.tui,
		theme,
		new KeybindingsManager(),
		async () => models,
		cache,
		(model) => picked.push(model),
	);
	ui.dock(search);
	for (const key of "acme") ui.terminal.input(key);
	ui.tui.renderNow();
	await ui.wheel("down", 4, ui.rowOf(/acme\/tiny-GGUF/));
	assert.match(ui.screen()[ui.rowOf(/acme\/small-GGUF/)] ?? "", /❯ acme\/small-GGUF/);
	await ui.click(/acme\/large-GGUF/, "acme/large-GGUF");
	assert.deepEqual(picked, ["acme/large-GGUF"]);
	ui.tui.stop();
});

test("a click on a row of the MCP manager runs it, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 30);
	const view = new McpManagerView(ui.tui, theme, new KeybindingsManager());
	ui.dock(view);
	let chosen: string | undefined;
	void view
		.menu(() => ({
			title: "MCP servers",
			items: [
				{ value: "github", label: "github", description: "connected" },
				{ value: "linear", label: "linear", description: "needs auth" },
			],
			confirmLabel: "open",
			cancelLabel: "close",
		}))
		.then((value) => {
			chosen = value;
		});
	ui.tui.renderNow();
	await ui.click(/linear/, "linear");
	await flushClicks();
	assert.equal(chosen, "linear");
	ui.tui.stop();
});

const agent = (name: string): AgentConfig => ({
	name,
	source: "builtin",
	description: `Investigate ${name} failures`,
	systemPrompt: "Read the evidence before proposing a fix.",
	filePath: `/agents/${name}.md`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
});

test("a click on an agent in /agents opens its details, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 30);
	ui.mount(
		new AgentBrowser(
			[agent("planner"), agent("reviewer"), agent("worker")],
			theme,
			() => {},
			() => 30,
		),
	);
	await ui.click(/\breviewer\b/, "reviewer");
	assert.ok(
		ui.screen().some((line) => /╭─ reviewer/.test(line)),
		ui.screen().join("\n"),
	);
	assert.ok(ui.rowOf(/Investigate reviewer failures/) >= 0);
	ui.tui.stop();
});
