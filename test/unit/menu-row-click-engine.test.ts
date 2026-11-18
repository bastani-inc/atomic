/**
 * A list an extension shows from the isolated engine runs its rows on one click and moves its selection on the wheel,
 * as it does in the host process: driven through Atomic's fullscreen renderer with SGR mouse reports, with the host's
 * mirror of the engine component and the engine's custom-UI service joined by an in-process message pump.
 */
import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { SessionListOverlay } from "../../packages/intercom/ui/session-list.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { AgentBrowser } from "../../packages/subagents/src/tui/agent-browser.js";
import { type ClickScreen, makeClickScreen } from "../helpers/fullscreen-clicks.js";
import { sleep } from "../helpers/runtime.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Shows `factory`'s component from the engine on `ui`: in the prompt's place, or as an overlay. */
async function showFromEngine(
	ui: ClickScreen,
	factory: Parameters<EngineCustomUiService["custom"]>[0],
	overlay: boolean,
): Promise<{ dispose(): void }> {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const engine = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) for (const listener of [...listeners]) listener(message);
	}, new KeybindingsManager());
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) =>
			engine.handleLine(serializeInteractiveEngineFrame(command)),
	} as unknown as IsolatedInteractiveRuntime;
	let mounted = false;
	const host = {
		requestRender: () => ui.tui.requestRender(),
		setWidget: () => {},
		custom: (create: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component) =>
			new Promise(() => {
				const component = create(ui.tui, {}, {}, () => {});
				if (overlay) ui.mount(component);
				else ui.dock(component);
				mounted = true;
			}),
	} as unknown as ExtensionUIContext;
	new RemoteComponentController(runtime, host, { isFullscreen: () => true, onRendererReplaced: () => () => {} });
	void engine.custom(factory, overlay ? { overlay: true } : undefined);
	for (let attempt = 0; attempt < 200 && !mounted; attempt++) await sleep(5);
	await settle(ui);
	return { dispose: () => engine.dispose() };
}

/** Lets the engine's frames reach the host and paints them. */
async function settle(ui: ClickScreen): Promise<void> {
	for (let round = 0; round < 10; round++) {
		ui.tui.renderNow();
		await sleep(5);
	}
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

test("the wheel over a list shown from the engine in the prompt's place moves its selection", async () => {
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
		const selected = () => ui.screen().find((line) => line.includes("›")) ?? "";
		assert.match(selected(), /alpha/);
		await ui.wheel("down", 6, ui.rowOf(/\balpha\b/));
		await settle(ui);
		assert.match(selected(), /bravo/, ui.screen().join("\n"));
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});

test("the wheel over a list an engine overlay shows moves its selection", async () => {
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
		await ui.wheel("down", 6, ui.rowOf(/worker \(/));
		await settle(ui);
		assert.match(ui.screen().find((line) => line.includes("→")) ?? "", /reviewer/, ui.screen().join("\n"));
	} finally {
		shown.dispose();
		ui.tui.stop();
	}
});
