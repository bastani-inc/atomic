/**
 * One left click runs a picker row as moving there and pressing Enter would, driven through Atomic's fullscreen
 * renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ExtensionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/extension-selector.js";
import {
	FramedSelector,
	PLAIN_SELECTOR_STYLE,
	type SelectorItem,
} from "../../packages/coding-agent/src/modes/interactive/components/selector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { leavePaneVisible } from "../helpers/engine-click-screen.js";
import { makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

const items = (labels: readonly string[]): SelectorItem<string>[] =>
	labels.map((label) => ({ id: label, value: label, label }));

for (const width of [80, 160]) {
	test(`a click on a ctx.ui.select row chooses it, at ${width} columns`, () => {
		const ui = makeClickScreen(width);
		const chosen: string[] = [];
		const dialog = new ExtensionSelectorComponent(
			"Deploy target",
			["staging", "production", "canary"],
			(option) => chosen.push(option),
			() => {},
		);
		ui.dock(dialog);
		return ui.click(/production/, "production").then(() => {
			assert.deepEqual(chosen, ["production"]);
			ui.tui.stop();
		});
	});
}

for (const host of ["local", "engine"] as const) {
	test(`one click from the composer selects a row in an unfocused picker (${host})`, async () => {
		const ui = makeClickScreen();
		const picked: string[] = [];
		const picker = new ExtensionSelectorComponent(
			"Pick",
			["red", "blue"],
			(value) => picked.push(value),
			() => {},
		);
		const mounted = await leavePaneVisible(ui, picker, host, false);
		try {
			await ui.click("blue");
			assert.deepEqual(picked, ["blue"]);
			assert.ok(ui.tui.getFocusedComponent() === mounted.pane);
		} finally {
			mounted.dispose();
			ui.tui.stop();
		}
	});
}

test("a click on No in a confirm dialog answers no, and Yes answers yes", async () => {
	for (const [answer, expected] of [
		["No", false],
		["Yes", true],
	] as const) {
		const ui = makeClickScreen();
		const answers: boolean[] = [];
		const dialog = new ExtensionSelectorComponent(
			"Import session\nReplace current session?",
			["Yes", "No"],
			(option) => answers.push(option === "Yes"),
			() => {},
		);
		ui.dock(dialog);
		await ui.click(new RegExp(`\\b${answer}\\s*$`), answer);
		assert.deepEqual(answers, [expected]);
		ui.tui.stop();
	}
});

test("a double-click on a multi-select row toggles it once", async () => {
	const ui = makeClickScreen();
	const picker = new FramedSelector<string>({
		title: "Models",
		items: items(["alpha", "bravo", "charlie"]),
		mode: "multi",
		style: PLAIN_SELECTOR_STYLE,
	});
	ui.dock(picker);
	await ui.doubleClick(/bravo/, "bravo");
	assert.deepEqual(
		picker.selector.state.getChecked().map((item) => item.id),
		["bravo"],
	);
	ui.tui.stop();
});

test("a drag across picker rows selects their text and chooses nothing", async () => {
	const ui = makeClickScreen();
	const chosen: string[] = [];
	const picker = new FramedSelector<string>({
		title: "Pick one",
		items: items(["alpha", "bravo", "charlie"]),
		style: PLAIN_SELECTOR_STYLE,
		onSelect: (item) => chosen.push(item.id),
	});
	ui.dock(picker);
	const from = ui.rowOf(/bravo/);
	const to = ui.rowOf(/charlie/);
	await ui.drag(
		{ column: ui.columnOf(from, "bravo"), row: from },
		{ column: ui.columnOf(to, "charlie") + 2, row: to },
	);
	assert.deepEqual(chosen, []);
	assert.equal(ui.copied.length, 1);
	assert.match(ui.copied[0] ?? "", /^bravo\n\s+cha$/);
	ui.tui.stop();
});

test("a click on the description line of a two-line row chooses that row", async () => {
	const ui = makeClickScreen();
	const chosen: string[] = [];
	const picker = new FramedSelector<string>({
		title: "Sessions",
		layout: "two-line",
		items: [
			{ id: "one", value: "one", label: "First session", description: "3 messages · yesterday" },
			{ id: "two", value: "two", label: "Second session", description: "9 messages · today" },
		],
		style: PLAIN_SELECTOR_STYLE,
		onSelect: (item) => chosen.push(item.id),
	});
	ui.dock(picker);
	await ui.click(/9 messages/, "9 messages");
	assert.deepEqual(chosen, ["two"]);
	ui.tui.stop();
});

test("a click on a disabled row chooses nothing, and the wheel moves the selection", async () => {
	const ui = makeClickScreen();
	const chosen: string[] = [];
	const picker = new FramedSelector<string>({
		title: "Pick one",
		items: [
			{ id: "a", value: "a", label: "alpha" },
			{ id: "b", value: "b", label: "bravo", disabled: true },
			{ id: "c", value: "c", label: "charlie" },
		],
		style: PLAIN_SELECTOR_STYLE,
		onSelect: (item) => chosen.push(item.id),
	});
	ui.dock(picker);
	await ui.click(/bravo/, "bravo");
	assert.deepEqual(chosen, []);
	const row = ui.rowOf(/alpha/);
	await ui.wheel("down", 4, row);
	assert.equal(picker.selector.getSelected()?.id, "c");
	ui.tui.stop();
});
