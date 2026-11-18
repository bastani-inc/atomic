/**
 * One left click runs a row of the settings picker, the resource list (/config) and a workflow's input form as moving
 * there and pressing Enter would, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { getKeybindings, type SettingItem, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type ResourceItem,
	ResourceList,
} from "../../packages/coding-agent/src/modes/interactive/components/config-selector-list.js";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.js";
import { SettingsPicker } from "../../packages/coding-agent/src/modes/interactive/components/settings-picker.js";
import { SelectSubmenu } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-submenus.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

for (const width of [80, 160]) {
	test(`a click on a setting changes it, and a click on a submenu setting opens it and chooses there, at ${width} columns`, async () => {
		const ui = makeClickScreen(width);
		const changes: string[] = [];
		const items: SettingItem[] = [
			{ id: "autocompact", label: "Auto-compact", currentValue: "true", values: ["true", "false"] },
			{
				id: "thinking",
				label: "Thinking level",
				currentValue: "low",
				submenu: (current, done) =>
					new SelectSubmenu(
						"Thinking level",
						"",
						["low", "medium", "high"].map((value) => ({ value, label: value })),
						current,
						(value) => done(value),
						() => done(),
					),
			},
		];
		const picker = new SettingsPicker(
			items,
			(id, value) => changes.push(`${id}=${value}`),
			() => {},
			{
				title: "Settings",
			},
		);
		ui.dock(picker);
		await ui.click(/Auto-compact/, "Auto-compact");
		assert.deepEqual(changes, ["autocompact=false"]);

		await ui.click(/Thinking level/, "Thinking level");
		await ui.click(/\bhigh\b/, "high");
		assert.deepEqual(changes, ["autocompact=false", "thinking=high"]);
		ui.tui.stop();
	});
}

test("a double-click on a setting changes it once", async () => {
	const ui = makeClickScreen();
	const changes: string[] = [];
	const picker = new SettingsPicker(
		[{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two", "three"] }],
		(id, value) => changes.push(`${id}=${value}`),
		() => {},
		{ title: "Settings" },
	);
	ui.dock(picker);
	await ui.doubleClick(/Mode/, "Mode");
	assert.deepEqual(changes, ["mode=two"]);
	ui.tui.stop();
});

function form(onSubmit: (values: Record<string, string>) => void) {
	const ui = makeClickScreen(100, 40);
	const component = new HostInputFormComponent(
		ui.tui,
		theme,
		new KeybindingsManager(),
		{
			title: "deploy",
			fields: [
				{ name: "target", type: "select", choices: ["staging", "production"], initialValue: "staging" },
				{ name: "dry_run", type: "boolean", initialValue: "true" },
				{ name: "note", type: "string", initialValue: "" },
			],
		},
		{ onSubmit, onCancel: () => {} },
	);
	ui.dock(component);
	return { ui, component };
}

test("a click on a choice of a workflow input form picks it, and a click on submit submits the form", async () => {
	const submitted: Record<string, string>[] = [];
	const { ui } = form((values) => submitted.push(values));
	await ui.click(/○ production/, "production");
	await ui.click(/○ off/, "off");
	assert.deepEqual(submitted, []);
	await ui.click(/\[ Submit \]/, "Submit");
	assert.deepEqual(submitted, [{ target: "production", dry_run: "false", note: "" }]);
	ui.tui.stop();
});

test("a click on a field's name in a workflow input form focuses it, so typing goes there", async () => {
	const submitted: Record<string, string>[] = [];
	const { ui, component } = form((values) => submitted.push(values));
	await ui.click(/▸? note/, "note");
	component.handleInput("x");
	component.handleInput("\t");
	component.handleInput("\r");
	assert.deepEqual(submitted, [{ target: "staging", dry_run: "true", note: "x" }]);
	ui.tui.stop();
});

test("a click on a resource in the resource list switches it, as enter on it does", async () => {
	const ui = makeClickScreen();
	const skillPaths: string[][] = [];
	const settingsManager = {
		getGlobalSettings: () => ({ skills: [] }),
		setSkillPaths: (paths: string[]) => skillPaths.push(paths),
	};
	const item = (name: string): ResourceItem => ({
		path: `/agent/skills/${name}/SKILL.md`,
		enabled: true,
		metadata: { source: "local", scope: "user", origin: "top-level", baseDir: "/agent/skills" },
		resourceType: "skills",
		displayName: name,
		groupKey: "user",
		subgroupKey: "skills",
	});
	const list = new ResourceList(
		[
			{
				key: "user",
				label: "User",
				scope: "user",
				origin: "top-level",
				source: "local",
				subgroups: [{ type: "skills", label: "Skills", items: [item("review"), item("release")] }],
			},
		],
		settingsManager as never,
		"/workspace",
		"/agent",
		30,
	);
	const toggled: string[] = [];
	list.onToggle = (resource, enabled) => toggled.push(`${resource.displayName}=${enabled}`);
	ui.dock(list);
	await ui.click(/\brelease\b/, "release");
	assert.deepEqual(toggled, ["release=false"]);
	assert.deepEqual(skillPaths, [["-release/SKILL.md"]]);
	ui.tui.stop();
});
