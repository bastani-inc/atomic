import assert from "node:assert/strict";
import { matchesKey, readHintSpans, stripHintMarkers, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	shortTaskTitle,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	AGENT_PANEL_FADE_MS,
	AGENT_PANEL_MAIN_ID,
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	agentPanelKeys,
	formatPanelElapsed,
	renderAgentPanelHint,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { applyAttachedComposer } from "../../packages/coding-agent/src/modes/interactive/components/input-label.js";
import { getGlobalTheme } from "../../packages/coding-agent/src/modes/interactive/theme/global-theme.js";
import {
	getEditorTheme,
	initTheme,
	setThemeInstance,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	agentPanelRows,
	bindAgentPanel,
	themedAgentPanelStyle,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { formatTokenCount } from "../../packages/coding-agent/src/utils/token-count.js";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";
import { makeTestTui } from "../support/fake-tui.js";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

const ROWS: AgentPanelRow[] = [
	{
		id: "task:a",
		kind: "agent",
		state: "running",
		name: "worker",
		task: "fix shipping batches",
		elapsedMs: 41 * 60_000,
		tokens: 96_100,
	},
	{
		id: "task:b",
		kind: "agent",
		state: "running",
		name: "debugger",
		task: "#5220 spawn lock",
		elapsedMs: 18 * 60_000,
		tokens: 87_400,
	},
	{
		id: "run:r",
		kind: "agent",
		state: "running",
		name: "ralph",
		task: "stage implement",
		elapsedMs: 12 * 60_000,
		tokens: 61_000,
	},
	{ id: "task:c", kind: "agent", state: "done", name: "worker", task: "picker clamp", elapsedMs: 6 * 60_000 },
];

test("panel styling preserves foreground overrides on installed theme instances (#5239)", () => {
	initTheme("dark");
	const previous = getGlobalTheme()!;
	const customized = Object.create(previous) as typeof previous;
	customized.fg = (color, text) => previous.fg(color, `[${text}]`);
	try {
		setThemeInstance(customized);
		assert.equal(themedAgentPanelStyle().muted("content"), theme.fg("muted", "content"));
	} finally {
		setThemeInstance(previous);
	}
});

test("panel colors and running marks follow theme, color and motion changes after cached renders (#5239)", () => {
	initTheme("dark");
	const previous = getGlobalTheme()!;
	const noColor = process.env.NO_COLOR;
	const reducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	const paint = themedAgentPanelStyle();
	try {
		for (const name of ["dark", "light", "dark"]) {
			initTheme(name);
			for (const color of [undefined, "1"]) {
				if (color === undefined) delete process.env.NO_COLOR;
				else process.env.NO_COLOR = color;
				for (const motion of [undefined, "1"]) {
					if (motion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
					else process.env.ATOMIC_REDUCED_MOTION = motion;
					for (let paints = 0; paints < 3; paints++) {
						const line = renderAgentPanelRows([ROWS[0]!], 100, paint)[0]!;
						assert.ok(line.startsWith(`  ${theme.fg("muted", "◯")} `));
						assert.ok(visibleWidth(line) <= 100);
					}
					for (const colorName of ["dim", "text", "muted", "accent", "success", "error", "warning"] as const) {
						assert.equal(paint[colorName]("nested\x1b[39mtext"), theme.fg(colorName, "nested\x1b[39mtext"));
					}
					assert.equal(paint.border("border"), theme.fg("borderMuted", "border"));
				}
			}
		}
	} finally {
		if (noColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = noColor;
		if (reducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
		else process.env.ATOMIC_REDUCED_MOTION = reducedMotion;
		setThemeInstance(previous);
	}
});

test("single-cell panel frames avoid repeated grapheme segmentation (#5239)", () => {
	initTheme("dark");
	const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
	try {
		for (let frame = 0; frame < 10; frame++) {
			segment.mockClear();
			const lines = renderAgentPanelRows(
				[{ ...ROWS[0]!, name: "cost7391", task: `frame cost probe 7391-${frame}` }],
				120,
				plain,
			);
			assert.equal(segment.mock.calls.filter(([text]) => text.includes("frame cost probe 7391")).length, 0);
			assert.equal(visibleWidth(lines[0]!), 120);
		}
	} finally {
		segment.mockRestore();
	}
});

test("repeated single-cell renders reuse their measured line widths (#5239)", () => {
	initTheme("dark");
	const rows = [{ ...ROWS[0]!, task: "steadyframe7392" }];
	for (let paints = 0; paints < 10; paints++) renderAgentPanelRows(rows, 120, plain);
	const replace = vi.spyOn(String.prototype, "replace");
	try {
		for (let paints = 0; paints < 20; paints++) renderAgentPanelRows(rows, 120, plain);
		assert.equal(
			replace.mock.contexts.filter((text) => typeof text === "string" && text.includes("steadyframe7392")).length,
			0,
		);
	} finally {
		replace.mockRestore();
	}
});

test("single-cell rendering still clamps styles that add visible text (#5239)", () => {
	const expanded: AgentPanelStyle = { ...plain, muted: (text) => `[${text}]`, accent: (text) => `界${text}` };
	for (const width of [40, 60, 80, 120]) {
		for (const selectedId of [undefined, ROWS[0]!.id]) {
			const lines = renderAgentPanelRows([ROWS[0]!], width, expanded, { selectedId });
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
});

test("panel rows show glyph, name, task, elapsed and tokens, right-aligned at 160 and 80 columns (#5224)", () => {
	const wide = renderAgentPanelRows(ROWS, 160, plain);
	assert.deepEqual(
		wide.map((line) => line.replace(/ {2,}/g, "  ").trimEnd()),
		[
			"  ◯ worker  fix shipping batches  41m · ↓ 96.1k tokens",
			"  ◯ debugger  #5220 spawn lock  18m · ↓ 87.4k tokens",
			"  ◯ ralph  stage implement  12m · ↓ 61.0k tokens",
			"  ● worker  picker clamp  done · 6m",
		],
	);
	for (const width of [160, 80]) {
		const lines = renderAgentPanelRows(ROWS, width, plain);
		assert.ok(lines.every((line) => visibleWidth(line) === width || line.endsWith("6m")));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const narrow = renderAgentPanelRows(ROWS, 56, plain);
	assert.match(narrow[0]!, /41m$/, "narrow rows drop tokens");
	assert.match(narrow[2]!, /stage implement/, "narrow rows retain the task text");
	const tiny = renderAgentPanelRows(ROWS, 30, plain);
	assert.deepEqual(tiny[0], "  ◯ worker", "very narrow rows keep the glyph and name");
});

test("the unfocused panel shows four rows and folds the rest; empty renders nothing (#5224)", () => {
	const many = Array.from({ length: 6 }, (_, index) => ({ ...ROWS[0]!, id: `task:${index}` }));
	const lines = renderAgentPanelRows(many, 100, plain);
	assert.equal(lines.length, 5);
	assert.equal(lines.at(-1), "  +2 more");
	assert.deepEqual(renderAgentPanelRows([], 100, plain), []);
});

test("rendering collapsed panel rows does not measure hidden names (#5224, #5239)", () => {
	let reads = 0;
	const rows = Array.from({ length: 10_000 }, (_, index) => ({
		...ROWS[0]!,
		id: `hidden:${index}`,
		get name() {
			reads++;
			return `worker${index}`;
		},
	}));
	const idle = renderAgentPanelRows(rows, 80, plain);
	assert.equal(idle.length, 5);
	assert.ok(reads <= 12, `only visible names are measured, read ${reads}`);
	reads = 0;
	const focused = renderAgentPanelRows(rows, 80, plain, { selectedId: "hidden:9999", scroll: 9992 });
	assert.equal(focused.length, 10);
	assert.ok(reads <= 24, `only the focused window is measured, read ${reads}`);
});

test("rows sort needing input, running, then finished; kept finished rows fade, and the rest leave at once (#5224)", () => {
	let now = 0;
	const model = new AgentPanelModel(() => now);
	const stopped: AgentPanelRow = { ...ROWS[3]!, state: "stopped" };
	const rows: AgentPanelRow[] = [
		stopped,
		{ ...ROWS[0]! },
		{ id: "run:q", kind: "agent", state: "input", name: "ralph", task: "approve the plan?" },
	];
	assert.deepEqual(
		model.rows(rows).map((row) => row.id),
		["run:q", "task:a", "task:c"],
		"a stopped subagent stays, last, while something is active",
	);
	assert.equal(model.faded(stopped), false);
	now += AGENT_PANEL_FADE_MS;
	assert.equal(model.faded(stopped), true, "a finished row reads dim after a while");
	assert.deepEqual(
		model.rows([{ ...ROWS[3]! }, { ...ROWS[0]! }]).map((row) => row.id),
		["task:a"],
		"a done subagent leaves at once",
	);
});

test("panel row ordering reads each status a bounded number of times in a large mixed list (#5224, #5239)", () => {
	let reads = 0;
	const states = ["stopped", "running", "queued", "input", "stopping"] as const;
	const rows = Array.from(
		{ length: 10_000 },
		(_, index): AgentPanelRow => ({
			...ROWS[0]!,
			id: `rank:${index}`,
			get state() {
				reads++;
				return states[index % states.length]!;
			},
		}),
	);
	const shown = new AgentPanelModel(() => 0).rows(rows);
	assert.equal(shown.length, rows.length);
	assert.equal(shown[0]?.id, "rank:3");
	assert.equal(shown[1999]?.id, "rank:9998");
	assert.equal(shown.at(-1)?.id, "rank:9995");
	assert.ok(reads <= rows.length * 4, `status reads stay linear without repeated comparisons: ${reads}`);
});

function focusFixture(now: () => number = () => 0) {
	const calls: string[] = [];
	const focus = new AgentPanelFocus(
		new KeybindingsManager(),
		{
			open: (row) => calls.push(`open ${row.id}`),
			stop: (row) => calls.push(`stop ${row.id}`),
			dismiss: (row) => calls.push(`dismiss ${row.id}`),
			close: () => calls.push("close"),
		},
		now,
	);
	focus.update(ROWS);
	focus.enter();
	focus.notePainted(ROWS);
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	return { focus, calls, press };
}

test("the focused panel: ↑↓ select through main, enter or → opens, esc and ↑ past main return to the prompt (#5224)", () => {
	const { focus, calls, press } = focusFixture();
	assert.equal(focus.selectedId, "task:a", "focus starts on the first row below main");
	press("\x1b[B");
	assert.equal(focus.selectedId, "task:b");
	press("\r");
	press("\x1b[C");
	assert.deepEqual(calls, ["open task:b", "open task:b"]);
	press("\x1b[A");
	press("\x1b[A");
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID);
	press("\r");
	assert.equal(calls.at(-1), "close", "Enter on main returns to the prompt");
	press("\x1b[A");
	assert.equal(calls.at(-1), "close", "↑ past main returns to the prompt");
	press("\x1b");
	assert.equal(calls.at(-1), "close");
	const lines = renderAgentPanelRows(ROWS, 80, plain, { selectedId: "task:b" }).map((line) =>
		stripVTControlCharacters(line).trimEnd(),
	);
	assert.equal(lines[0], "  ● main");
	assert.match(lines[2]!, /^∀ ◯ debugger/);
});

test("x stops a running row only on a second press within three seconds and dismisses a finished one (#5224)", () => {
	let now = 0;
	const { focus, calls, press } = focusFixture(() => now);
	press("x");
	assert.deepEqual(calls, []);
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focus, 80, plain, new KeybindingsManager())),
		"  Press x again within 3s to stop worker",
	);
	now += 2000;
	press("x");
	assert.deepEqual(calls, ["stop task:a"]);
	press("x");
	now += 3500;
	press("x");
	assert.deepEqual(calls, ["stop task:a"], "a late second press arms again");
	press("\x1b[B");
	press("\x1b[B");
	press("\x1b[B");
	assert.equal(focus.selectedId, "task:c");
	press("x");
	assert.equal(calls.at(-1), "dismiss task:c");
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focus, 160, plain, new KeybindingsManager())),
		"  ↑↓ select · enter/→ to open · x dismiss · esc/← back to prompt · ? keys",
	);
	press("?");
	assert.equal(focus.helpOpen, true);
	press("x");
	assert.equal(calls.at(-1), "dismiss task:c", "keys wait while the overlay is open");
	press("\x1b");
	assert.equal(focus.helpOpen, false);
});

test("focused panel disarms pending stop when opening or closing ? help, closes on physical Escape/Left even when app.keys.help is remapped, and filters dead esc from help hints (#5224)", () => {
	let now = 0;
	const { focus, calls, press } = focusFixture(() => now);

	// 1. x arms stop, ? opens help and disarms stopConfirm, Esc closes help, next x within 3s re-arms instead of stopping
	press("x");
	assert.equal(focus.pendingStop()?.id, "task:a");
	now += 500;
	press("?");
	assert.equal(focus.helpOpen, true);
	assert.equal(focus.pendingStop(), undefined, "opening ? help disarms a waiting stop confirmation");
	now += 500;
	press("\x1b");
	assert.equal(focus.helpOpen, false);
	assert.deepEqual(calls, [], "Esc while helpOpen closes only help without closing the panel or stopping");
	now += 500;
	press("x");
	assert.deepEqual(calls, [], "first x after closing help arms afresh instead of stopping");
	assert.equal(focus.pendingStop()?.id, "task:a");
	now += 500;
	press("x");
	assert.deepEqual(calls, ["stop task:a"]);

	// 2. Remapping app.keys.help to escape/left never steals physical Escape or Left from closing the panel, and omits dead esc from hints
	const remapped = new KeybindingsManager({
		"app.keys.help": ["escape", "?"],
	});
	const remappedCalls: string[] = [];
	const remappedFocus = new AgentPanelFocus(
		remapped,
		{
			open: (row) => remappedCalls.push(`open ${row.id}`),
			stop: (row) => remappedCalls.push(`stop ${row.id}`),
			dismiss: (row) => remappedCalls.push(`dismiss ${row.id}`),
			close: () => remappedCalls.push("close"),
		},
		() => now,
	);
	remappedFocus.update(ROWS);
	remappedFocus.enter();
	const remappedPress = (data: string) =>
		remappedFocus.handleInput(data, (input, key) => matchesKey(input, key as "up"));

	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(remappedFocus, 160, plain, remapped)),
		"  ↑↓ select · enter/→ to open · x stop · esc/← back to prompt · ? keys",
	);
	const escapeOnlyHelp = new KeybindingsManager({ "app.keys.help": ["escape"] });
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(remappedFocus, 160, plain, escapeOnlyHelp)),
		"  ↑↓ select · enter/→ to open · x stop · esc/← back to prompt",
	);
	assert.equal(
		agentPanelKeys(remappedFocus.selected(), escapeOnlyHelp).some((entry) => entry.label === "keys"),
		false,
	);

	remappedPress("\x1b");
	assert.equal(remappedFocus.helpOpen, false, "physical Escape closes the panel instead of opening remapped help");
	assert.deepEqual(remappedCalls, ["close"]);
});

test("focused panel hints omit open and stop aliases shadowed by help or open, and open-shadowed stop keys disarm pending confirmation (#5224)", () => {
	let now = 0;

	// 1. app.keys.help = "x" shadows default stop "x": x opens help, and hint shows x keys without dead x stop
	const helpOnX = new KeybindingsManager({ "app.keys.help": "x" });
	const helpOnXCalls: string[] = [];
	const focusHelpX = new AgentPanelFocus(
		helpOnX,
		{
			open: (row) => helpOnXCalls.push(`open ${row.id}`),
			stop: (row) => helpOnXCalls.push(`stop ${row.id}`),
			dismiss: (row) => helpOnXCalls.push(`dismiss ${row.id}`),
			close: () => helpOnXCalls.push("close"),
		},
		() => now,
	);
	focusHelpX.update(ROWS);
	focusHelpX.enter();
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focusHelpX, 160, plain, helpOnX)),
		"  ↑↓ select · enter/→ to open · esc/← back to prompt · x keys",
	);
	focusHelpX.handleInput("x", (input, key) => matchesKey(input, key as "up"));
	assert.equal(focusHelpX.helpOpen, true);
	assert.deepEqual(helpOnXCalls, []);

	// 2. app.keys.help = "enter" shadows "enter" on open but keeps "→": enter opens help, → opens row, hint shows → to open and enter keys
	const helpOnEnter = new KeybindingsManager({ "app.keys.help": "enter" });
	const helpOnEnterCalls: string[] = [];
	const focusHelpEnter = new AgentPanelFocus(
		helpOnEnter,
		{
			open: (row) => helpOnEnterCalls.push(`open ${row.id}`),
			stop: (row) => helpOnEnterCalls.push(`stop ${row.id}`),
			dismiss: (row) => helpOnEnterCalls.push(`dismiss ${row.id}`),
			close: () => helpOnEnterCalls.push("close"),
		},
		() => now,
	);
	focusHelpEnter.update(ROWS);
	focusHelpEnter.enter();
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focusHelpEnter, 160, plain, helpOnEnter)),
		"  ↑↓ select · → to open · x stop · esc/← back to prompt · enter keys",
	);
	focusHelpEnter.handleInput("\r", (input, key) => matchesKey(input, key as "up"));
	assert.equal(focusHelpEnter.helpOpen, true);
	assert.deepEqual(helpOnEnterCalls, []);
	focusHelpEnter.handleInput("\x1b", (input, key) => matchesKey(input, key as "up"));
	assert.equal(focusHelpEnter.helpOpen, false);
	focusHelpEnter.handleInput("\x1b[C", (input, key) => matchesKey(input, key as "up"));
	assert.deepEqual(helpOnEnterCalls, ["open task:a"]);

	// 3. app.list.open = "x" and app.list.stop = ["ctrl+k", "x"]: ctrl+k arms stop, x opens row and disarms pending stop, next ctrl+k arms afresh
	const openShadowsStop = new KeybindingsManager({
		"app.list.open": "x",
		"app.list.stop": ["ctrl+k", "x"],
	});
	const shadowCalls: string[] = [];
	const focusShadow = new AgentPanelFocus(
		openShadowsStop,
		{
			open: (row) => shadowCalls.push(`open ${row.id}`),
			stop: (row) => shadowCalls.push(`stop ${row.id}`),
			dismiss: (row) => shadowCalls.push(`dismiss ${row.id}`),
			close: () => shadowCalls.push("close"),
		},
		() => now,
	);
	focusShadow.update(ROWS);
	focusShadow.enter();
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focusShadow, 160, plain, openShadowsStop)),
		"  ↑↓ select · x to open · ctrl+k stop · esc/← back to prompt · ? keys",
	);
	const pressShadow = (data: string) => focusShadow.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	pressShadow("\x0b");
	assert.equal(focusShadow.pendingStop()?.id, "task:a");
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focusShadow, 160, plain, openShadowsStop)),
		"  Press ctrl+k again within 3s to stop worker",
	);
	now += 400;
	pressShadow("x");
	assert.deepEqual(shadowCalls, ["open task:a"], "x opens the row rather than confirming stop");
	assert.equal(focusShadow.pendingStop(), undefined, "open-shadowed x disarms the pending stop confirmation");
	now += 400;
	pressShadow("\x0b");
	assert.deepEqual(shadowCalls, ["open task:a"], "next ctrl+k arms afresh instead of stopping");
	assert.equal(focusShadow.pendingStop()?.id, "task:a");
});

test("a stop confirmation keeps terminal controls in a source's name inert (#5224, #5239)", () => {
	const { focus, press } = focusFixture();
	focus.update([{ ...ROWS[0]!, name: "\x1b]0;changed-title\x07\u202e" }]);
	focus.enter();
	press("x");
	const hint = renderAgentPanelHint(focus, 160, plain, new KeybindingsManager());
	assert.doesNotMatch(stripHintMarkers(hint), /[\x1b\x07\u202e]/u);
	assert.match(stripVTControlCharacters(hint), /^ {2}Press x again within 3s to stop/);
	assert.deepEqual(
		readHintSpans(hint).spans.map((span) => [span.start, span.end, span.action]),
		[[8, 15, { kind: "key", key: "x" }]],
		"only the key, x again, is marked for a click",
	);
});

test("rows whose name, task or stage label starts with combining marks stay within terminal width (#5224)", () => {
	initTheme("dark");
	const previous = getGlobalTheme()!;
	const style = themedAgentPanelStyle();
	const rows: AgentPanelRow[] = [
		{
			id: "task:mark-task",
			kind: "agent",
			state: "running",
			name: "worker",
			task: "\u093E\u302E fix the build",
			elapsedMs: 5_000,
			tokens: 96_100,
		},
		{
			id: "task:mark-both",
			kind: "agent",
			state: "running",
			name: "\u093E\u302Edebugger",
			task: "\u093E\u0301…",
			elapsedMs: 18_000,
			tokens: 87_400,
		},
	];
	try {
		for (const themeName of ["dark", "light"] as const) {
			initTheme(themeName);
			for (const width of [40, 80, 120]) {
				for (const selectedId of [undefined, AGENT_PANEL_MAIN_ID, ...rows.map((row) => row.id)]) {
					const lines = renderAgentPanelRows(rows, width, style, {
						...(selectedId === undefined ? {} : { selectedId }),
					});
					for (const line of lines) {
						assert.ok(
							visibleWidth(line) <= width,
							`width=${width} selected=${String(selectedId)} actual=${visibleWidth(line)}: ${JSON.stringify(stripVTControlCharacters(line))}`,
						);
						assert.doesNotMatch(stripVTControlCharacters(line), /\p{M}/u);
					}
					const firstTaskLine = stripVTControlCharacters(lines[selectedId === undefined ? 0 : 1]!);
					assert.ok(firstTaskLine.endsWith(width >= 70 ? "5s · ↓ 96.1k tokens" : "5s"), firstTaskLine);
				}
				const markStyle: AgentPanelStyle = {
					...style,
					muted: (text) => style.muted(`\u093E\u302E${text}`),
					text: (text) => style.text(`\u093E\u302E${text}`),
				};
				for (const line of renderAgentPanelRows(rows, width, markStyle)) {
					assert.ok(visibleWidth(line) <= width);
				}
			}
		}
	} finally {
		setThemeInstance(previous);
	}
});

test("token units roll over after rounding (#5224, #5239)", () => {
	assert.equal(formatTokenCount(999_949), "999.9k");
	assert.equal(formatTokenCount(999_950), "1.0M");
	assert.equal(formatTokenCount(999_999), "1.0M");
	assert.equal(formatTokenCount(999_950_000), "1.0B");
	assert.equal(formatTokenCount(Number.MAX_SAFE_INTEGER), "9.0Q");
});

test("token counts round fractional values and reject malformed counts (#5224, #5239)", () => {
	assert.equal(formatTokenCount(0.1 + 0.2), "0");
	assert.equal(formatTokenCount(1e-7), "0");
	assert.equal(formatTokenCount(999.9), "1.0k");
	for (const value of [NaN, Infinity, -1, "\x1b[2J", Symbol("tokens"), Object.create(null)]) {
		assert.equal(formatTokenCount(value as number), "0");
	}
});

test("panel time and token formats (#5224)", () => {
	assert.equal(formatPanelElapsed(9_000), "9s");
	assert.equal(formatPanelElapsed(41 * 60_000), "41m");
	assert.equal(formatPanelElapsed(91 * 60_000), "1h 31m");
	assert.equal(formatTokenCount(812), "812");
	assert.equal(formatTokenCount(96_100), "96.1k");
	assert.equal(formatTokenCount(1_250_000), "1.3M");
});

test("the panel lists a session's extension items and background tasks together, newest first (#5224)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	try {
		await fixture.start("first task");
		await fixture.start("second task");
		const hub = new AgentPanelSourceHub();
		let run: AgentPanelItem = {
			id: "run:r1",
			kind: "agent",
			state: "running",
			name: "ralph",
			task: "stage implement",
			progress: { done: 3, total: 5 },
		};
		const opened: string[] = [];
		hub.register({ items: () => [run], subscribe: () => () => {}, open: (id) => opened.push(id) });
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);
		assert.deepEqual(
			agentPanelRows(session).map((row) => `${row.name}:${row.task}`),
			["worker:second task", "worker:first task", "ralph:stage implement"],
		);
		assert.equal(openAgentPanelItem(session, "run:r1"), true);
		assert.deepEqual(opened, ["run:r1"]);
		run = { ...run, state: "done" };
		dismissedAgentPanelItems(session).add("run:r1");
		assert.deepEqual(
			agentPanelRows(session).map((row) => row.name),
			["worker", "worker"],
			"a dismissed item leaves the panel",
		);
	} finally {
		await fixture.dispose();
	}
});

test("an attached composer has accent rules naming its target and a placeholder (#5224)", () => {
	const style = { accent: (text: string) => text, text: (text: string) => text, dim: (text: string) => text };
	const realEditor = new CustomEditor(makeTestTui(24), getEditorTheme(), new KeybindingsManager(), { paddingX: 0 });
	realEditor.focused = true;
	const raw = applyAttachedComposer(
		style,
		"debugger · #5220 spawn lock · 18m",
		"Message debugger…",
		realEditor.render(80),
	);
	assert.equal(raw[1], "❯ \x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07Message debugger…");
	const lines = raw.map((line) => stripTerminalSequences(line));
	assert.equal(
		lines[0],
		`${"─".repeat(80 - " debugger · #5220 spawn lock · 18m ".length - 1)} debugger · #5220 spawn lock · 18m ─`,
	);
	assert.equal(lines[1], "❯  Message debugger…");
	assert.equal(lines[2], "─".repeat(80));
	const typed = applyAttachedComposer(style, "x", "Message debugger…", ["─".repeat(80), "❯ hi", "─".repeat(80)]);
	assert.equal(typed[1], "❯ hi", "typed text replaces the placeholder");
	const narrow = applyAttachedComposer(style, "debugger", undefined, ["─".repeat(30), "❯", "─".repeat(30)]);
	assert.equal(narrow[0], "─".repeat(30), "narrow terminals keep the rule without the label");
});

test("an attached composer preserves cursor markers and terminal styling around its placeholder (#5245)", () => {
	const style = { accent: (text: string) => text, text: (text: string) => text, dim: (text: string) => text };
	for (const [line, expected] of [
		["❯   ", "❯ hint"],
		["❯   \x1b[31m\x1b[0m", "❯\x1b[31m\x1b[0m hint"],
		["❯\t   \x1b[m", "❯\t\x1b[m hint"],
		["❯   \x1b[0K", "❯   \x1b[0K hint"],
		["❯ \x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07", "❯ \x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07hint"],
		["❯ \x1b_outer\x1b_inner\x07", "❯ \x1b_outer\x1b_inner\x07 hint"],
		["❯ \x1b_unterminated", "❯ \x1b_unterminated"],
		["❯ typed", "❯ typed"],
	]) {
		const rendered = applyAttachedComposer(style, undefined, "hint", ["─".repeat(80), line!, "─".repeat(80)]);
		assert.equal(rendered[1], expected);
	}
});

test("← also leaves the focused panel, and coming back selects the row that was open (#5224)", () => {
	const { focus, calls, press } = focusFixture();
	press("\x1b[D");
	assert.equal(calls.at(-1), "close", "← goes back to the prompt");
	focus.enter("task:c");
	assert.equal(focus.selectedId, "task:c", "the row opened before is selected again");
	focus.enter("task:gone");
	assert.equal(focus.selectedId, "task:a", "a row that left falls back to the first");
	focus.selectedId = AGENT_PANEL_MAIN_ID;
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focus, 160, plain, new KeybindingsManager())),
		"  ↑↓ select · enter/→ to open · esc/← back to prompt · ? keys",
		"the main row offers open but no stop",
	);
});

test("a workflow row opens through its source with a way back to the panel (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	let returned = 0;
	const opened: Array<{ id: string; onReturn?: () => void }> = [];
	hub.register({
		items: () => [{ id: "run:r", kind: "agent", state: "running", name: "ralph", task: "" }],
		subscribe: () => () => {},
		open: (id, options) => opened.push({ id, ...(options?.onReturn ? { onReturn: options.onReturn } : {}) }),
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	assert.equal(openAgentPanelItem(session, "run:r", { onReturn: () => returned++ }), true);
	opened[0]?.onReturn?.();
	assert.equal(returned, 1);
	assert.equal(openAgentPanelItem(session, "run:missing"), false);
});

test("a burst of source changes rebuilds the mounted panel's rows once, then follows the next change (#4009, #5224)", async () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	let reads = 0;
	let items: AgentPanelItem[] = [{ id: "run:r", kind: "agent", state: "running", name: "ralph", task: "" }];
	hub.register({
		items: () => {
			reads++;
			return items;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let mounts = 0;
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
			if (typeof content === "function") {
				mounts++;
				widget = content({} as never, {} as never) as never;
			} else widget = undefined;
		},
		requestRender() {},
	} as never);
	try {
		assert.equal(mounts, 1);
		reads = 0;
		for (let change = 0; change < 200; change++) for (const listener of listeners) listener();
		assert.equal(reads, 0, "nothing is rebuilt inside the burst");
		await vi.waitFor(() => assert.ok(reads > 0, "the burst reached the mounted panel"));
		assert.ok(reads <= 2, `one rebuild for the burst, read ${reads} times`);
		items = [];
		for (const listener of listeners) listener();
		await vi.waitFor(() => assert.equal(widget, undefined, "the next change still reaches the panel"));
	} finally {
		dispose();
	}
});

test("the focused panel scrolls to keep the selection in view and keeps every row reachable (#5224)", () => {
	const many: AgentPanelRow[] = Array.from({ length: 12 }, (_, index) => ({
		...ROWS[0]!,
		id: `task:${index}`,
		name: `w${index}`,
	}));
	const focus = new AgentPanelFocus(new KeybindingsManager(), {
		open() {},
		stop() {},
		dismiss() {},
		close() {},
	});
	focus.update(many);
	focus.enter();
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	const shown = () =>
		renderAgentPanelRows(many, 80, plain, { selectedId: focus.selectedId, scroll: focus.scroll }).map((line) =>
			line.trimEnd(),
		);
	for (let step = 0; step < 11; step++) press("\x1b[B");
	assert.equal(focus.selectedId, "task:11");
	assert.ok(
		shown().some((line) => line.startsWith("∀ ◯ w11")),
		"the last row is reachable and shown",
	);
	assert.ok(shown().length <= 1 + 8 + 1, "main, eight rows and the fold line at most");
	press("\x1b[H");
	assert.equal(focus.selectedId, "main");
	assert.ok(
		shown().some((line) => line.startsWith("  ◯ w0")),
		"Home scrolls back to the top",
	);
	focus.selectedId = "task:5";
	focus.update(many.filter((row) => row.id !== "task:5"));
	assert.equal(focus.selectedId, "task:6", "a row that leaves moves the selection to the next row");
});

test("duplicate row ids do not trap focused keyboard navigation (#5224, #5239)", () => {
	const { focus, press } = focusFixture();
	focus.update([ROWS[0]!, ROWS[0]!, ROWS[1]!]);
	focus.selectedId = AGENT_PANEL_MAIN_ID;
	press("\x1b[B");
	press("\x1b[B");
	assert.equal(focus.selectedId, ROWS[1]!.id);
	press("\x1b[B");
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID, "↓ on the last row wraps past the duplicate to main");
});

test("↓ on the last row wraps to the first row and scrolls back to the top", () => {
	const many: AgentPanelRow[] = Array.from({ length: 12 }, (_, index) => ({
		...ROWS[0]!,
		id: `task:${index}`,
		name: `w${index}`,
	}));
	const calls: string[] = [];
	const focus = new AgentPanelFocus(new KeybindingsManager(), {
		open() {},
		stop() {},
		dismiss() {},
		close: () => calls.push("close"),
	});
	focus.update(many);
	focus.enter();
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	for (let step = 0; step < 11; step++) press("\x1b[B");
	assert.equal(focus.selectedId, "task:11");
	assert.equal(focus.scroll, 4);
	press("\x1b[B");
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID, "↓ on the last row wraps to main, the first row");
	assert.equal(focus.scroll, 0);
	press("\x1b[B");
	assert.equal(focus.selectedId, "task:0");
	assert.deepEqual(calls, [], "wrapping never leaves the panel");

	// A row added below the last one: ↓ moves onto it instead of wrapping.
	press("\x1b[F");
	assert.equal(focus.selectedId, "task:11");
	const grown = [...many, { ...ROWS[0]!, id: "task:12", name: "w12" }];
	focus.update(grown);
	press("\x1b[B");
	assert.equal(focus.selectedId, "task:12");

	// The last row leaves while selected: the selection moves to the new last row, and ↓ wraps from there.
	focus.update(many);
	assert.equal(focus.selectedId, "task:11");
	press("\x1b[B");
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID);
	assert.equal(focus.scroll, 0);
});

test("without a main row, ↓ on the last row wraps to the first row and ↑ on the first row still returns to the prompt", () => {
	const shells: AgentPanelRow[] = ["s0", "s1", "s2"].map((id) => ({ ...ROWS[0]!, id, kind: "shell", name: id }));
	const calls: string[] = [];
	const focus = new AgentPanelFocus(new KeybindingsManager(), {
		open() {},
		stop() {},
		dismiss() {},
		close: () => calls.push("close"),
	});
	focus.update(shells);
	focus.enter();
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	assert.equal(focus.showMain, false);
	press("\x1b[B");
	press("\x1b[B");
	assert.equal(focus.selectedId, "s2");
	press("\x1b[B");
	assert.equal(focus.selectedId, "s0");
	assert.deepEqual(calls, []);
	press("\x1b[A");
	assert.deepEqual(calls, ["close"], "↑ on the first row returns to the prompt, it does not wrap");

	// One row: ↓ keeps it selected.
	focus.update([shells[0]!]);
	press("\x1b[B");
	assert.equal(focus.selectedId, "s0");

	// A remembered main with no main row listed falls back to the first row.
	focus.update(shells);
	focus.enter(undefined, { selectedKey: AGENT_PANEL_MAIN_ID, orderKeys: ["s0", "s1", "s2"], scroll: 0 });
	assert.equal(focus.selectedId, "s0");
});

test("a remembered main is restored when the panel lists main", () => {
	const { focus } = focusFixture();
	focus.enter(undefined, { selectedKey: AGENT_PANEL_MAIN_ID, orderKeys: ROWS.map((row) => row.id), scroll: 0 });
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID);
	assert.equal(focus.scroll, 0);
});

test("the panel resets its scroll when the selected rows disappear and main remains selected (#5224, #5239)", () => {
	const { focus } = focusFixture();
	const many = Array.from({ length: 12 }, (_, index) => ({ ...ROWS[0]!, id: `scroll:${index}` }));
	focus.update(many);
	focus.enter("scroll:11");
	assert.equal(focus.scroll, 4);
	focus.update([]);
	focus.update(many.slice(0, 3));
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID);
	assert.equal(focus.scroll, 0);
	const lines = renderAgentPanelRows(many.slice(0, 3), 80, plain, {
		selectedId: focus.selectedId,
		scroll: focus.scroll,
	});
	assert.equal(lines.length, 4);
	assert.ok(lines.slice(1).every((line) => line.includes("worker")));
});

test("a source that throws is left out of the panel, reported once, and never crashes the host (#4009, #5224)", async () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	let broken = false;
	hub.register({
		items: () => {
			if (broken) throw new Error("source exploded");
			return [{ id: "run:ok", kind: "agent", state: "running", name: "ralph", task: "" }];
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	hub.register({
		items: () => [{ id: "run:other", kind: "agent", state: "running", name: "other", task: "" }],
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const reports: string[] = [];
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", onUncaught);
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
		notify: (message: string) => reports.push(message),
	} as never);
	try {
		broken = true;
		for (const listener of listeners) listener();
		for (const listener of listeners) listener();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(uncaught, [], "the deferred refresh stays inside its task");
		assert.deepEqual(
			agentPanelRows(session).map((row) => row.name),
			["other"],
			"the other source's rows still show",
		);
		assert.match(widget?.render(80).join("\n") ?? "", /other/);
		assert.equal(reports.length, 1, "the failure is reported once");
		assert.match(reports[0] ?? "", /source exploded/);
	} finally {
		process.off("uncaughtException", onUncaught);
		dispose();
	}
});

test("a row that finishes between the two x presses is not dismissed by the second one (#5224)", () => {
	const { focus, calls, press } = focusFixture();
	press("x");
	assert.equal(focus.pendingStop()?.id, "task:a");
	focus.update([{ ...ROWS[0]!, state: "done" }, ...ROWS.slice(1)]);
	assert.equal(focus.pendingStop(), undefined, "the stop is called off");
	assert.equal(
		stripVTControlCharacters(renderAgentPanelHint(focus, 80, plain, new KeybindingsManager())),
		"  worker finished · x to acknowledge",
	);
	press("x");
	assert.deepEqual(calls, [], "the press meant as the second one only acknowledges the notice");
	focus.notePainted([{ ...ROWS[0]!, state: "done" }, ...ROWS.slice(1)]);
	press("x");
	assert.deepEqual(calls, ["dismiss task:a"], "a later press dismisses it");
});

test("short task titles keep whole characters and count the ellipsis inside 60 units (#5654)", () => {
	const prefix = "x".repeat(58);
	for (const cluster of ["😀", "e\u0301", "👩‍💻"]) {
		assert.equal(shortTaskTitle(`${prefix}${cluster}more`), `${prefix}…`);
	}
	assert.equal(shortTaskTitle(`${"x".repeat(57)}😀more`), `${"x".repeat(57)}😀…`);
	assert.equal(shortTaskTitle("a".repeat(61)), `${"a".repeat(59)}…`);
	assert.equal(shortTaskTitle(`${prefix}😀`), `${prefix}😀`);
	assert.equal(shortTaskTitle(`${"w".repeat(40)}\u0600 ${"v".repeat(30)}`), `${"w".repeat(40)}…`);
});

test("a row names a task by a short title, not the subagent's whole prompt (#5224)", () => {
	assert.equal(
		shortTaskTitle(
			"Start `sleep 90` with the bash tool in the background. Then use the wait tool on that task until it finishes.",
		),
		"Start `sleep 90` with the bash tool in the background.",
	);
	assert.equal(shortTaskTitle("\n  fix the picker clamp\nthen run the tests"), "fix the picker clamp");
	const long = shortTaskTitle(`Investigate ${"the flaky spawn lock ".repeat(6)}`);
	assert.ok(long.length <= 61 && long.endsWith("…"), long);
});
