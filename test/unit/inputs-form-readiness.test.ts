import assert from "node:assert/strict";
import { type Terminal, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

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

function makeHostForm(fields: HostInputFormField[], title = "ralph") {
	const submitted: Record<string, string>[] = [];
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{ title, heading: "WORKFLOW INPUTS", fields },
		{ onSubmit: (values) => submitted.push(values), onCancel: () => {} },
	);
	return {
		component,
		submitted,
		plainAt: (width: number) =>
			component
				.render(width)
				.map((line) => stripVTControlCharacters(line))
				.join("\n"),
	};
}

test("validation reason stays visible when the field title truncates or the form is narrow (#5224)", () => {
	const longName = "n".repeat(100);
	const hostLong = makeHostForm([{ name: longName, type: "integer", required: true, initialValue: "1.5" }]);
	assert.match(hostLong.plainAt(60), /✗ must be a whole number/);

	const hostNarrow = makeHostForm([{ name: "f", type: "number", required: true, initialValue: "NaN" }]);
	assert.match(hostNarrow.plainAt(32), /✗ must be a number/);

	const hostWrapped = makeHostForm([{ name: longName, type: "integer", required: true, initialValue: "1.5" }]);
	assert.match(hostWrapped.plainAt(24).replace(/│/g, " ").replace(/\s+/g, " "), /✗ must be a whole number/);
});

test("control sequences in field names, descriptions, choices, and values are sanitized in rendered lines while preserving raw values on submit (#5224)", () => {
	const payloads = ["\x1b[2J", "\x1b]52;c;QVVESVQ=\x07", "\x1b]0;pwn\x07", "a\rb", "a\x07b"];

	for (const payload of payloads) {
		const rawName = `field_${payload}`;
		const rawChoice = `choice_${payload}`;
		const rawDesc = `desc_${payload}`;
		const rawVal = `val_${payload}`;

		const host = makeHostForm(
			[
				{ name: rawName, type: "string", required: true, description: rawDesc, initialValue: rawVal },
				{ name: "notes", type: "text", required: true, initialValue: rawVal },
				{ name: "sel", type: "select", required: true, choices: [rawChoice], initialValue: rawChoice },
			],
			`wf_${payload}`,
		);
		host.component.handleInput("!");
		const hostLinesFocused0 = host.component.render(80);
		host.component.handleInput("\t");
		const hostLinesFocused1 = host.component.render(80);
		for (const rawLine of [...hostLinesFocused0, ...hostLinesFocused1]) {
			const line = rawLine.replace(/\x1b_pi:(?:\/?fc|c|\/h|h:[^\x07\x1b]*)\x07/g, "");
			assert.equal(line.includes("\x1b[2J"), false, `host leaked CSI 2J for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]52;"), false, `host leaked OSC 52 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]0;"), false, `host leaked OSC 0 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\r"), false, `host leaked CR for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x07"), false, `host leaked BEL for ${JSON.stringify(payload)}`);
		}
		host.component.handleInput("\t");
		host.component.handleInput("\t");
		host.component.handleInput("\r");
		assert.deepEqual(host.submitted, [{ [rawName]: `${rawVal}!`, notes: rawVal, sel: rawChoice }]);
	}
});

test("host input form bounds heading and body to the requested width down to 1 column (#5224)", () => {
	const host = makeHostForm([
		{
			name: "objective",
			type: "string",
			required: true,
			description: "Describe the workflow objective in detail.",
			initialValue: "Fix narrow width overflow",
		},
		{ name: "mode", type: "select", required: true, choices: ["fast", "careful"], initialValue: "fast" },
		{ name: "dry_run", type: "boolean", required: true, initialValue: "true" },
	]);
	for (const width of [1, 2, 4, 8, 12, 18]) {
		const lines = host.component.render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`width=${width}: line has visibleWidth=${visibleWidth(line)}: ${JSON.stringify(stripVTControlCharacters(line))}`,
			);
		}
	}
});
