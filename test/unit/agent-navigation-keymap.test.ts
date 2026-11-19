import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripHintMarkers, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { WorkflowRunSummary } from "../../packages/coding-agent/src/core/extensions/workflow-run-control.js";
import { KeybindingsManager, migrateKeybindingsConfig } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type StopAllBackgroundOutcome,
	stopAllBackgroundMessage,
	stopAllBackgroundWork,
} from "../../packages/coding-agent/src/core/tasks/stop-all.js";
import {
	type NavKey,
	type NavKeyStyle,
	navActionText,
	renderNavHintLine,
	renderNavKeyOverlay,
	TwoPressConfirm,
} from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	createStopAllChord,
	createStopAllNotices,
} from "../../packages/coding-agent/src/modes/interactive/interactive-stop-all.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const plainStyle: NavKeyStyle = {
	// Hint lines are compared as the terminal shows them, without their zero-width click markers.
	dim: (text) => stripHintMarkers(text),
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
};

const CTRL_X = "\x18";
const CTRL_K = "\x0b";

test("the navigation actions have their documented defaults (#5224)", () => {
	const keys = new KeybindingsManager();
	assert.deepEqual(keys.getKeys("app.nav.back"), ["left"]);
	assert.deepEqual(keys.getKeys("app.list.open"), ["enter", "right"]);
	assert.deepEqual(keys.getKeys("app.list.stop"), ["x"]);
	assert.deepEqual(keys.getKeys("app.list.peek"), ["space"]);
	assert.deepEqual(keys.getKeys("app.list.filter"), ["/"]);
	assert.deepEqual(keys.getKeys("app.keys.help"), ["?"]);
	assert.deepEqual(keys.getKeys("app.agents.focus"), ["down"]);
	assert.deepEqual(keys.getKeys("app.agents.chord"), ["ctrl+x"]);
	assert.deepEqual(keys.getKeys("app.agents.stopAll"), ["ctrl+k"]);
	assert.deepEqual(keys.getKeys("app.auth.copyUrl"), ["ctrl+x"], "the OAuth copy key is unchanged");
	assert.deepEqual(keys.getKeys("app.interrupt"), ["escape"]);
});

test("old task ids migrate to the list ids, and a new id already set wins (#5224)", () => {
	const migrated = migrateKeybindingsConfig({ "app.tasks.inspect": "ctrl+e", "app.tasks.cancel": "ctrl+k" });
	assert.equal(migrated.migrated, true);
	assert.deepEqual(migrated.config, { "app.list.open": "ctrl+e", "app.list.stop": "ctrl+k" });
	const both = migrateKeybindingsConfig({ "app.tasks.cancel": "ctrl+k", "app.list.stop": "ctrl+s" });
	assert.deepEqual(both.config, { "app.list.stop": "ctrl+s" });
});

const KEYS: readonly NavKey[] = [
	{ keys: "↑↓", label: "select" },
	{ action: "app.list.open", label: "open" },
	{ action: "app.list.stop", label: "stop" },
	{ keys: "esc", label: "back to prompt" },
	{ action: "app.keys.help", label: "keys" },
];

test("one dim hint line names exactly the screen's keys and fits 80 and 160 columns (#5224)", () => {
	const keys = new KeybindingsManager();
	for (const width of [160, 80]) {
		const line = renderNavHintLine(KEYS, width, plainStyle, keys);
		assert.equal(line, "  ↑↓ select · enter/→ open · x stop · esc back to prompt · ? keys");
		assert.ok(visibleWidth(line) <= width);
	}
	// Narrow terminals drop whole entries from the end instead of cutting one mid-word.
	const narrow = renderNavHintLine(KEYS, 37, plainStyle, keys);
	assert.equal(narrow, "  esc back to prompt · ? keys");
	assert.ok(visibleWidth(renderNavHintLine(KEYS, 8, plainStyle, keys)) <= 8);
	for (const width of [1, 2, 8]) {
		const single = [{ keys: "esc", label: "cancel this picker" }];
		assert.ok(visibleWidth(renderNavHintLine(single, width, plainStyle, keys)) <= width);
	}
});

test("hints follow remaps, leave out unbound actions and never repeat a key two actions share (#5224)", () => {
	const remapped = new KeybindingsManager({ "app.list.stop": "ctrl+k", "app.keys.help": [] });
	assert.equal(navActionText(remapped, "app.list.stop"), "ctrl+k");
	assert.equal(
		renderNavHintLine(KEYS, 160, plainStyle, remapped),
		"  ↑↓ select · enter/→ open · ctrl+k stop · esc back to prompt",
	);
	const shared = new KeybindingsManager({ "app.list.open": "x" });
	assert.equal(renderNavHintLine(KEYS, 160, plainStyle, shared), "  ↑↓ select · x open · esc back to prompt · ? keys");
});

test("the ? overlay lists every key in a rounded box, and degrades to plain rows when narrow (#5224)", () => {
	const keys = new KeybindingsManager();
	for (const width of [160, 80]) {
		const box = renderNavKeyOverlay("keys · tasks", KEYS, width, plainStyle, keys).map(stripHintMarkers);
		assert.match(box[0] ?? "", /^╭─ keys · tasks ─+╮$/);
		assert.match(box.at(-1) ?? "", /^╰─+╯$/);
		assert.ok(box.every((line) => visibleWidth(line) === width));
		assert.match(box.join("\n"), /│ enter\/→ +open +│/);
		assert.match(box.join("\n"), /│ esc\/\? +close this help +│/);
	}
	const narrow = renderNavKeyOverlay("keys", KEYS, 20, plainStyle, keys).map(stripHintMarkers);
	assert.equal(narrow[0], "keys");
	assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
});

test("a second press confirms only on the same target within three seconds (#5224)", () => {
	let now = 0;
	const confirm = new TwoPressConfirm(() => now);
	assert.equal(confirm.press("a"), false);
	assert.equal(confirm.pending(), "a");
	assert.equal(confirm.press("b"), false, "another target starts over");
	now += 3000;
	assert.equal(confirm.press("b"), true);
	assert.equal(confirm.pending(), undefined);
	assert.equal(confirm.press("a"), false);
	now += 3001;
	assert.equal(confirm.pending(), undefined, "the window closes after three seconds");
	assert.equal(confirm.press("a"), false);
});

function chordHost(chordAllowed = true) {
	const statuses: string[] = [];
	const warnings: string[] = [];
	let stops = 0;
	let outcome: StopAllBackgroundOutcome = { agents: 2, shells: 1, workflowRuns: 1, failures: [] };
	const host = {
		keybindings: new KeybindingsManager(),
		chordAllowed: () => chordAllowed,
		stopAll: async () => {
			stops++;
			return outcome;
		},
		showStatus: (message: string) => statuses.push(message),
		showWarning: (message: string) => warnings.push(message),
		clearStatus: () => statuses.push("<cleared>"),
	};
	return {
		host,
		statuses,
		warnings,
		stops: () => stops,
		setOutcome(next: StopAllBackgroundOutcome) {
			outcome = next;
		},
	};
}

test("Ctrl+X Ctrl+K stops all background work only after a second press within three seconds (#5224)", async () => {
	let now = 0;
	const h = chordHost();
	const listener = createStopAllChord(h.host, () => now);
	assert.equal(listener(CTRL_X), undefined, "Ctrl+X starts the chord and still reaches whatever has the keyboard");
	assert.deepEqual(listener(CTRL_K), { consume: true }, "Ctrl+K right after it belongs to the chord");
	assert.equal(h.stops(), 0);
	assert.deepEqual(h.statuses, ["Press ctrl+x ctrl+k again within 3s to stop all"]);
	now += 2000;
	listener(CTRL_X);
	listener(CTRL_K);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.stops(), 1);
	assert.equal(h.statuses.at(-1), "Stopped 2 subagents, 1 shell and 1 workflow run.");
	// A late second press arms again instead of stopping.
	listener(CTRL_X);
	listener(CTRL_K);
	now += 3500;
	listener(CTRL_X);
	listener(CTRL_K);
	assert.equal(h.stops(), 1);
});

test("the chord works in every view; any other key ends it, and a dialog that binds Ctrl+X keeps it (#5224)", () => {
	const h = chordHost();
	const listener = createStopAllChord(h.host);
	listener(CTRL_X);
	assert.equal(listener("a"), undefined, "the chord ends and the key is typed");
	assert.equal(listener(CTRL_K), undefined, "Ctrl+K without the chord stays an editor key");
	const dialog = chordHost(false);
	const dialogListener = createStopAllChord(dialog.host);
	assert.equal(dialogListener(CTRL_X), undefined, "a dialog such as OAuth sign-in keeps Ctrl+X");
	dialogListener(CTRL_K);
	dialogListener(CTRL_X);
	assert.equal(dialogListener(CTRL_K), undefined);
	assert.equal(dialog.stops(), 0);
});

test("any key but the stop-all key calls a waiting stop-all off and clears its notice (#5224)", async () => {
	let now = 0;
	const h = chordHost();
	const listener = createStopAllChord(h.host, () => now);
	listener(CTRL_X);
	listener(CTRL_K);
	assert.match(h.statuses.at(-1) ?? "", /again within 3s/);
	listener(CTRL_X);
	assert.equal(listener("a"), undefined, "the key still reaches the prompt");
	assert.equal(h.statuses.at(-1), "<cleared>", "the notice is cleared");
	now += 1000;
	listener(CTRL_X);
	listener(CTRL_K);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.stops(), 0, "the next chord arms again instead of stopping");
	listener("b");
	assert.equal(h.statuses.at(-1), "<cleared>");
});

test("Ctrl+X pressed twice restarts the chord, so Ctrl+X Ctrl+K after a stray Ctrl+X still counts (#5224)", () => {
	const h = chordHost();
	const listener = createStopAllChord(h.host);
	listener(CTRL_X);
	listener(CTRL_X);
	assert.deepEqual(listener(CTRL_K), { consume: true });
	assert.match(h.statuses.at(-1) ?? "", /again within 3s/);
});

test("stop-all chord never consumes physical Escape even when remapped, and disarms pending confirmation when chordAllowed becomes false (#5224)", async () => {
	let now = 0;
	let allowed = true;
	const statuses: string[] = [];
	let stops = 0;
	const remapped = new KeybindingsManager({
		"app.agents.chord": ["escape", "ctrl+x"],
		"app.agents.stopAll": ["escape", "ctrl+k"],
	});
	const listener = createStopAllChord(
		{
			keybindings: remapped,
			chordAllowed: () => allowed,
			stopAll: async () => {
				stops += 1;
				return { agents: 1, shells: 0, workflowRuns: 0, failures: [] };
			},
			showStatus: (msg) => statuses.push(msg),
			showWarning: (msg) => statuses.push(msg),
			clearStatus: () => statuses.push("<cleared>"),
		},
		() => now,
	);

	// 1. Escape after Ctrl+X cancels the chord and passes through without arming stop-all
	assert.equal(listener(CTRL_X), undefined);
	assert.equal(listener("\x1b"), undefined, "Escape after Ctrl+X must cancel the chord and pass through");
	assert.equal(statuses.length, 0);

	// 2. Escape alone never opens the chord even when app.agents.chord includes escape
	assert.equal(listener("\x1b"), undefined);
	assert.equal(listener(CTRL_K), undefined, "Ctrl+K after Escape must not arm stop-all");
	assert.equal(statuses.length, 0);

	// 3. Arm confirmation with Ctrl+X Ctrl+K, then Escape cancels the pending confirmation
	listener(CTRL_X);
	assert.deepEqual(listener(CTRL_K), { consume: true });
	assert.match(statuses.at(-1) ?? "", /Press ctrl\+x ctrl\+k again within 3s/);
	assert.equal(listener("\x1b"), undefined);
	assert.equal(statuses.at(-1), "<cleared>");

	// 4. Arm confirmation again, then a key pressed while chordAllowed is false disarms confirmation
	now += 500;
	listener(CTRL_X);
	assert.deepEqual(listener(CTRL_K), { consume: true });
	allowed = false;
	assert.equal(listener("a"), undefined);
	assert.equal(statuses.at(-1), "<cleared>", "blocked dialog key disarms pending stop-all confirmation");
	allowed = true;
	now += 500;
	listener(CTRL_X);
	assert.deepEqual(listener(CTRL_K), { consume: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stops, 0, "chord after blocked dialog arms afresh instead of confirming stop-all");
});

test("a stop-all that cannot stop everything says what is left (#5224)", () => {
	assert.equal(
		stopAllBackgroundMessage({ agents: 0, shells: 0, workflowRuns: 0, failures: [] }),
		"No background work to stop.",
	);
	assert.equal(
		stopAllBackgroundMessage({ agents: 1, shells: 0, workflowRuns: 0, failures: ["workflow abc: pause_failed"] }),
		"Stopped 1 subagent. Could not stop: workflow abc: pause_failed",
	);
});

test("stop-all stops the session's background subagents and shells and quits its workflow runs (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("first agent");
		await fixture.start("second agent");
		await fixture.start("a shell");
		// The fixture launches agents; one counts as the shell it stands in for.
		(fixture.store.tasks[2] as { kind: string }).kind = "command";
		const session = {};
		bindOwnerTaskStore(session, fixture.store);
		const quits: unknown[] = [];
		const running: WorkflowRunSummary = {
			runId: "run-1",
			name: "ralph",
			status: "running",
			startedAt: 0,
			elapsedMs: 1,
			activeStages: [],
			awaitingInputCount: 0,
			awaitingInput: [],
		};
		const outcome = await stopAllBackgroundWork(
			Object.assign(session, {
				workflows: {
					listRuns: async () => [
						running,
						{ ...running, runId: "run-2", status: "completed" as const, endedAt: 1 },
					],
					quit: async (target: unknown) => {
						quits.push(target);
						return { action: "quit" as const, runId: "--all", status: "ok" as const, message: "" };
					},
				},
			}),
		);
		assert.deepEqual(outcome, { agents: 2, shells: 1, workflowRuns: 1, failures: [] });
		assert.deepEqual(quits, [{ all: true }]);
		fixture.store.drain();
		assert.ok(fixture.runners.every((runner) => runner.context.signal.aborted));
	} finally {
		await fixture.dispose();
	}
});

test("? opens the task list's key overlay and Esc closes it, keeping the list open (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	let closed = 0;
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {
			closed++;
		},
	);
	try {
		await fixture.start("Overlay task");
		const frame = () => stripVTControlCharacters(inspector.renderViewport(80, 24).join("\n"));
		assert.equal(inspector.handleInput("?"), true);
		assert.match(frame(), /keys · tasks/);
		assert.match(frame(), /x +stop/);
		inspector.handleInput("x");
		assert.equal(fixture.store.tasks[0]?.execution.kind, "running", "keys wait while the overlay is open");
		inspector.handleInput("\x1b");
		assert.doesNotMatch(frame(), /keys · tasks/);
		assert.match(frame(), /^ Tasks\b/m);
		assert.equal(closed, 0);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("an empty task list offers only the keys that do something (#5224)", () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		for (const width of [160, 80]) {
			const lines = inspector.renderViewport(width, 12).map((line) => stripVTControlCharacters(line));
			assert.equal(lines.at(-1), "  / filter · esc/← close · ? keys");
		}
	} finally {
		inspector.dispose();
		void fixture.dispose();
		setKeybindings(previous);
	}
});

test("stop-all notices show in the current view for one window and never in a transcript (#5224)", () => {
	const calls: string[] = [];
	let fire: (() => void) | undefined;
	const timers = {
		setTimeout: ((handler: () => void) => {
			fire = handler;
			return { unref() {} };
		}) as unknown as typeof setTimeout,
		clearTimeout: (() => {}) as typeof clearTimeout,
	};
	const isolated = createStopAllNotices(
		{
			setEngineNotice: (text) => calls.push(`engine:${text ?? "-"}`),
			hasOverlay: () => true,
			requestRender: () => {},
		},
		timers,
	);
	isolated.show("Press ctrl+x ctrl+k again");
	assert.deepEqual(calls, ["engine:-", "engine:Press ctrl+x ctrl+k again"], "the isolated engine's views show it");
	fire?.();
	assert.equal(calls.at(-1), "engine:-", "it clears when its window closes");
	calls.length = 0;
	let overlay = false;
	const local = createStopAllNotices(
		{
			setFooterStatus: (text) => calls.push(`footer:${text ?? "-"}`),
			showToast: (text) => {
				calls.push(`toast:${text}`);
				return () => calls.push("toast:hidden");
			},
			hasOverlay: () => overlay,
			requestRender: () => {},
		},
		timers,
	);
	local.show("Stopped 1 subagent.");
	assert.deepEqual(calls, ["footer:-", "footer:Stopped 1 subagent."], "over the chat: the footer status only");
	overlay = true;
	local.show("Press again");
	assert.ok(calls.includes("toast:Press again"), "over a fullscreen view: a floating line too");
	local.clear();
	assert.ok(calls.includes("toast:hidden"));
});
