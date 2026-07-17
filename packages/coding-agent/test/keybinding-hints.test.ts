import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { keyHint, keyHintIfBound, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousKeybindings = getKeybindings();

afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("keybinding hints", () => {
	test("uses Atomic's configured formatting for bound actions", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+x" }));
		initTheme("dark");
		expect(keyText("app.tools.expand")).toBe("ctrl+x");
		expect(stripAnsi(keyHint("app.tools.expand", "Expand"))).toBe("ctrl+x Expand");
	});

	test("omits the whole unavailable hint when an action is unbound", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		initTheme("dark");
		expect(keyText("app.tools.expand")).toBe("");
		expect(stripAnsi(keyHintIfBound("app.tools.expand", "Expand"))).toBe("");
		expect(stripAnsi(keyHint("app.tools.expand", "Expand"))).toBe(" Expand");
	});
});
