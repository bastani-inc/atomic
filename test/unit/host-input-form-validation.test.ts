import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

class QuietTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

beforeAll(() => {
	initTheme("dark");
});

function form(fields: HostInputFormField[]) {
	const submitted: Record<string, string>[] = [];
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{ title: "ralph", fields },
		{ onSubmit: (values) => submitted.push(values), onCancel: () => {} },
	);
	const text = () =>
		component
			.render(90)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
	return { component, submitted, text };
}

const FIELDS: HostInputFormField[] = [
	{ name: "objective", type: "string", required: true, initialValue: "Fix the benchmark" },
	{ name: "max_loops", type: "integer", initialValue: "1.5" },
	{ name: "mode", type: "select", required: true, choices: ["fast", "careful"], initialValue: "" },
	{ name: "dry_run", type: "boolean", required: true, initialValue: "" },
	{ name: "verbose", type: "boolean", initialValue: "yes" },
];

test("each field of the workflow inputs form shows ✓ when ready and ✗ with the reason when not (#5224)", () => {
	const { text } = form(FIELDS);
	const shown = text();
	assert.match(shown, /objective +.*✓/);
	assert.doesNotMatch(
		form([{ name: "goal", type: "string", required: true, initialValue: "" }]).text(),
		/required · ✗ required/,
	);
	assert.match(form([{ name: "goal", type: "string", required: true, initialValue: "" }]).text(), /goal +✗ required/);
	assert.match(shown, /max_loops +.*✗ must be a whole number/);
	assert.match(shown, /mode +.*✗ choose one/);
	assert.match(shown, /dry_run +.*✗ choose on or off/);
	assert.match(shown, /verbose +.*✗ must be on or off/);
});

test("the inputs form refuses to submit until every field is valid, and an unchosen select or boolean is never submitted as a default (#5224)", () => {
	const { component, submitted } = form(FIELDS);
	for (let i = 0; i < FIELDS.length; i++) component.handleInput("\t");
	component.handleInput("\r");
	assert.deepEqual(submitted, [], "invalid fields block the run");
	const ok = form([
		{ name: "mode", type: "select", choices: ["fast", "careful"], initialValue: "" },
		{ name: "verbose", type: "boolean", initialValue: "" },
	]);
	ok.component.handleInput("\t");
	ok.component.handleInput("\t");
	ok.component.handleInput("\r");
	assert.deepEqual(ok.submitted, [{ mode: "", verbose: "" }], "optional unset fields stay unset");
});

test("↓ on an unchosen select picks the first choice, and ↑ the last (#5224)", () => {
	const down = form([{ name: "mode", type: "select", required: true, choices: ["a", "b", "c"], initialValue: "" }]);
	down.component.handleInput("\x1b[B");
	assert.match(down.text(), /● a/);
	const up = form([{ name: "mode", type: "select", required: true, choices: ["a", "b", "c"], initialValue: "" }]);
	up.component.handleInput("\x1b[A");
	assert.match(up.text(), /● c/);
});
