/**
 * A list an extension shows from the isolated engine runs its rows on one click, as in the host process.
 * These tests drive Atomic's fullscreen renderer with SGR mouse reports, with the host's
 * mirror of the engine component and the engine's custom-UI service joined by an in-process message pump.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, type TuiMouseEvent } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type {
	ExtensionCommandContext,
	ExtensionUIContext,
} from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { showLlamaUi } from "../../packages/coding-agent/src/extensions/llama/ui.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { AgentBrowser } from "../../packages/subagents/src/tui/agent-browser.js";
import { showFromEngine } from "../helpers/engine-click-screen.js";
import { type ClickScreen, makeClickScreen } from "../helpers/fullscreen-clicks.js";
import { sleep } from "../helpers/runtime.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Lets the engine's frames reach the host and the paints they ask for run; nothing paints on the test's behalf. */
async function settle(_ui: ClickScreen): Promise<void> {
	await sleep(100);
}

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

test("a click on a row of a list shown from the engine runs it, and the host paints what it opened", async () => {
	const ui = makeClickScreen(100, 30);
	const shown = await showFromEngine(
		ui,
		() =>
			new AgentBrowser(
				[agent("alpha"), agent("bravo"), agent("charlie")],
				theme,
				() => {},
				() => 30,
			),
		false,
	);
	try {
		await ui.click(/\bcharlie\b/, "charlie");
		await settle(ui);
		assert.ok(
			ui.screen().some((line) => /╭─ charlie/.test(line)),
			ui.screen().join("\n"),
		);
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});

test("a non-capturing engine pane leaves focus in the composer until its first click", async () => {
	const ui = makeClickScreen();
	const composer = ui.tui.getFocusedComponent();
	const events: string[] = [];
	const shown = await showFromEngine(
		ui,
		() => ({
			render: () => ["Choose this pane"],
			invalidate() {},
			handleInput(data: string) {
				events.push(data);
				return true;
			},
			handleMouse(event: TuiMouseEvent) {
				if (event.type === "click") {
					events.push("clicked");
					return { handled: true };
				}
				return undefined;
			},
		}),
		true,
		{ anchor: "top-right", width: 20, nonCapturing: true },
	);
	try {
		assert.ok(ui.tui.getFocusedComponent() === composer, "the engine pane must not take focus on mount");
		await ui.click("Choose this pane");
		ui.terminal.input("a");
		await settle(ui);
		assert.deepEqual(events, ["clicked", "a"]);
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});

test("a click-only engine component acts without taking the composer's keyboard", async () => {
	const ui = makeClickScreen();
	const composer = ui.tui.getFocusedComponent();
	const clicked: string[] = [];
	const shown = await showFromEngine(
		ui,
		() => ({
			render: () => ["click-only card"],
			invalidate() {},
			handleMouse(event: TuiMouseEvent) {
				if (event.type !== "click") return undefined;
				clicked.push("card");
				return { handled: true };
			},
		}),
		false,
	);
	try {
		ui.focusComposer();
		await ui.click("click-only card");
		await settle(ui);
		assert.deepEqual(clicked, ["card"]);
		assert.ok(ui.tui.getFocusedComponent() === composer, "a display-only component cannot accept the next key");
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});

test("one click picks a search result inside the engine's bundled model manager", async () => {
	const ui = makeClickScreen();
	let mounted: ReturnType<typeof showFromEngine> | undefined;
	const custom: ExtensionUIContext["custom"] = (factory) => {
		mounted = showFromEngine(ui, factory, false);
		return new Promise(() => {});
	};
	const picked: Array<string | undefined> = [];
	void showLlamaUi({ ui: { custom } } as ExtensionCommandContext, async (manager) => {
		const model = await manager.searchModels(async () => [
			{ id: "alpha/first", downloads: 10 },
			{ id: "alpha/second", downloads: 5 },
		]);
		picked.push(model);
	});
	const shown = await mounted;
	try {
		ui.terminal.input("a");
		ui.terminal.input("l");
		await vi.waitFor(() => assert.match(ui.screen().join("\n"), /❯ alpha\/first/), { timeout: 5000 });
		await ui.click("alpha/second");
		await settle(ui);
		assert.deepEqual(picked, ["alpha/second"]);
	} finally {
		shown?.dispose();
		ui.tui.stop();
	}
});

test("one click chooses a session in an engine overlay", async () => {
	const ui = makeClickScreen(100, 40);
	const session = (id: string, name: string): SessionInfo => ({
		id,
		name,
		cwd: "/workspace/project",
		model: "test-model",
		pid: 1234,
		startedAt: 1,
		lastActivity: 2,
	});
	const picked: Array<string | undefined> = [];
	const shown = await showFromEngine(
		ui,
		(_tui, _theme, keys, done) =>
			new SessionListOverlay(
				theme,
				keys as KeybindingsManager,
				session("a-0", "planner"),
				[session("b-1", "worker"), session("c-2", "reviewer")],
				(chosen) => {
					picked.push(chosen?.name);
					done(undefined);
				},
			),
		true,
	);
	try {
		await ui.click(/reviewer \(/, "reviewer");
		await settle(ui);
		assert.deepEqual(picked, ["reviewer"]);
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});
