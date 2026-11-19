import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	dismissedAgentPanelItems,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

const microtasks = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

function run(id: string, state: AgentPanelItem["state"]): AgentPanelItem {
	return {
		id,
		kind: "workflow",
		state,
		name: id.slice(4),
		task: "stage build",
		elapsedMs: 1000,
		...(state === "done" ? { endedAt: Date.now() } : {}),
	};
}

function panelHarness(initial: AgentPanelItem[]) {
	let items = initial;
	const listeners = new Set<() => void>();
	const stopped: [string, string][] = [];
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop: async (id) => {
			stopped.push([id, items.find((item) => item.id === id)?.state ?? "gone"]);
			return { ok: true };
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	return {
		session,
		stopped,
		set(next: AgentPanelItem[]) {
			items = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

type Panel = { handleInput(data: string): void; render(width: number): string[]; dispose?(): void };
async function withFocusedPanel(session: object, body: (panel: Panel) => Promise<void> | void, selectId?: string) {
	await showAgentPanel(
		session as never,
		{
			custom: async (factory: never) => {
				let finish = () => {};
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const panel = (await (factory as (...args: unknown[]) => unknown)(
					{ requestRender() {} },
					theme,
					new KeybindingsManager(),
					finish,
				)) as Panel;
				await body(panel);
				panel.handleInput("\x1b");
				await finished;
				panel.dispose?.();
				return undefined as never;
			},
		} as never,
		selectId,
	);
}

const paint = (panel: Panel) => stripVTControlCharacters(panel.render(100).join("\n"));

test("one x aimed at a run drawn as running does not dismiss it after it finished unseen (#5224)", async () => {
	const p = panelHarness([run("run:deploy", "running")]);
	await withFocusedPanel(p.session, async (panel) => {
		const painted = paint(panel);
		assert.match(painted, /❯ .*deploy/);
		assert.match(painted, /x stop/);
		p.set([run("run:deploy", "done")]);
		await microtasks();
		panel.handleInput("x");
	});
	assert.equal(
		dismissedAgentPanelItems(p.session).has("run:deploy"),
		false,
		"one x dismissed a finished run the reader last saw running with `x stop`",
	);
});

test("the confirming x of a stop armed on one run never dismisses another (#5224)", async () => {
	const p = panelHarness([run("run:a", "running"), run("run:b", "done")]);
	await withFocusedPanel(
		p.session,
		async (panel) => {
			paint(panel);
			panel.handleInput("x");
			assert.match(paint(panel), /Press x again within 3s to stop a/);
			p.set([run("run:b", "done")]);
			await microtasks();
			panel.handleInput("x");
		},
		"run:a",
	);
	assert.equal(dismissedAgentPanelItems(p.session).has("run:b"), false, "the second x of a stop on A dismissed B");
});

test("x x on a run that finished between the presses sends no stop (#5224)", async () => {
	const p = panelHarness([run("run:deploy", "running")]);
	await withFocusedPanel(p.session, async (panel) => {
		paint(panel);
		panel.handleInput("x");
		p.set([run("run:deploy", "done")]);
		await microtasks();
		panel.handleInput("x");
		await microtasks();
	});
	assert.deepEqual(p.stopped, [], `stop sent for a finished run: ${JSON.stringify(p.stopped)}`);
});

test("one x aimed at the selected running run never dismisses another run a refresh moved the selection to (#5224)", async () => {
	const p = panelHarness([run("run:a", "running"), run("run:b", "done")]);
	await withFocusedPanel(
		p.session,
		async (panel) => {
			const painted = paint(panel);
			assert.match(painted, /❯ . a /, painted);
			p.set([run("run:b", "done")]);
			await microtasks();
			panel.handleInput("x");
		},
		"run:a",
	);
	assert.equal(
		dismissedAgentPanelItems(p.session).has("run:b"),
		false,
		"x aimed at the selected running a dismissed b",
	);
});

test("x x aimed at the selected running run never stops another run a refresh moved the selection to (#5224)", async () => {
	const p = panelHarness([run("run:a", "running"), run("run:b", "running")]);
	await withFocusedPanel(
		p.session,
		async (panel) => {
			const painted = paint(panel);
			assert.match(painted, /❯ . a /, painted);
			p.set([run("run:b", "running")]);
			await microtasks();
			panel.handleInput("x");
			panel.handleInput("x");
			await microtasks();
		},
		"run:a",
	);
	assert.deepEqual(p.stopped, [], `x x aimed at a stopped ${JSON.stringify(p.stopped)}`);
});
