import assert from "node:assert/strict";
import { TuiMainScreen } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { ScreenTerminal } from "../helpers/screen-terminal.js";

for (const type of ["string", "text"] as const) {
	test(`keeps raw ${type} input intact when editing an escaped prefill (#5224)`, () => {
		initTheme("dark");
		const raw = "before\x1b]52;c;QVVESVQ=\x07after";
		const submitted: Record<string, string>[] = [];
		const component = new HostInputFormComponent(
			new TuiMainScreen(new ScreenTerminal(100, 40)),
			theme,
			new KeybindingsManager(),
			{ title: "deploy", fields: [{ name: "value", type, initialValue: raw, required: true }] },
			{ onSubmit: (values) => submitted.push(values), onCancel() {} },
		);
		assert.equal(component.render(100).join("\n").includes("\x1b]52;"), false);
		component.handleInput("x");
		assert.equal(component.render(100).join("\n").includes("\x1b]52;"), false);
		component.handleInput("\t");
		component.handleInput("\r");
		assert.deepEqual(submitted, [{ value: `${raw}x` }]);
	});

	test(`keeps pasted terminal commands inert in a ${type} field (#5224)`, () => {
		initTheme("dark");
		const payload = "\x1b]52;c;QVVESVQ=\x07";
		const submitted: Record<string, string>[] = [];
		const component = new HostInputFormComponent(
			new TuiMainScreen(new ScreenTerminal(100, 40)),
			theme,
			new KeybindingsManager(),
			{ title: "deploy", fields: [{ name: "value", type, initialValue: "safe", required: true }] },
			{ onSubmit: (values) => submitted.push(values), onCancel() {} },
		);
		component.handleInput(`\x1b[200~${payload}\x1b[201~`);
		assert.equal(component.render(100).join("\n").includes("\x1b]52;"), false);
		component.handleInput("\t");
		component.handleInput("\r");
		const pasted = type === "text" ? "]52;c;QVVESVQ=" : payload;
		assert.deepEqual(submitted, [{ value: `safe${pasted}` }]);
	});
}
