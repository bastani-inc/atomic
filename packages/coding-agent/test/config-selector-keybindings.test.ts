import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	class FakeTui {
		terminal = { rows: 24 };
		addChild() {}
		setFocus() {}
		start() {}
		stop() {}
		requestRender() {}
	}
	return { ...actual, ProcessTerminal: class {}, TuiMainScreen: FakeTui };
});

vi.mock("../src/modes/interactive/components/config-selector.js", () => ({
	ConfigSelectorComponent: class {
		constructor(...args: unknown[]) {
			const onClose = args[4] as () => void;
			queueMicrotask(onClose);
		}
		getResourceList() {
			return {};
		}
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({
	initTheme: () => {},
	stopThemeWatcher: () => {},
}));

import { selectConfig } from "../src/cli/config-selector.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SettingsManager } from "../src/core/settings-manager.js";

describe("selectConfig keybindings", () => {
	let agentDir: string | undefined;

	afterEach(() => {
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
		setKeybindings(new KeybindingsManager({}));
	});

	it("uses the user's keybindings.json (pi #11788)", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "atomic-config-keys-"));
		writeFileSync(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "tui.select.up": ["up", "ctrl+p"], "tui.select.down": ["down", "ctrl+n"] }),
		);
		const settingsManager = {
			getTheme: () => undefined,
			getTerminalCapabilityOverrides: () => ({}),
		} as unknown as SettingsManager;

		await selectConfig({
			resolvedPaths: {} as never,
			settingsManager,
			cwd: agentDir,
			agentDir,
			writeScope: "global",
			projectModeAvailable: false,
		});

		assert.ok(getKeybindings().getKeys("tui.select.down").includes("ctrl+n"));
		assert.ok(getKeybindings().getKeys("tui.select.up").includes("ctrl+p"));
	});
});
