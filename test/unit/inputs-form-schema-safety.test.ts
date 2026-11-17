import assert from "node:assert/strict";
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

const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

function hostForm(fields: HostInputFormField[]) {
	const submitted: Record<string, string>[] = [];
	const tui = new TuiMainScreen(new QuietTerminal());
	const component = new HostInputFormComponent(
		tui,
		theme,
		new KeybindingsManager(),
		{ title: "demo", fields },
		{
			onSubmit: (values) => submitted.push(values),
			onCancel: () => {},
		},
	);
	return { component, submitted, tui };
}

const NO_OP_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["Delete at the end", ["\x1b[3~"]],
	["Ctrl+K at the end", ["\x0b"]],
	["Ctrl+D at the end", ["\x04"]],
	["Alt+D at the end", ["\x1bd"]],
	["Backspace at the start", ["\x01", "\x7f"]],
	["Ctrl+W at the start", ["\x01", "\x17"]],
];

for (const [label, keys] of NO_OP_KEYS) {
	for (const [size, pasted] of [
		["1200 characters", "q".repeat(1200)],
		["12 lines", "line\n".repeat(12)],
	] as const) {
		test(`host text field submits a pasted ${size} after ${label}, never the paste marker (#5224)`, () => {
			const { component, submitted } = hostForm([
				{ name: "prompt", type: "text", required: true, initialValue: "" },
			]);
			component.handleInput(paste(pasted));
			for (const key of keys) component.handleInput(key);
			component.handleInput("\t");
			component.handleInput("\r");
			assert.deepEqual(submitted, [{ prompt: pasted }]);
		});
	}
}
