import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, describe, it, vi } from "vitest";

const screens = vi.hoisted(() => [] as Array<{ terminal: { rows: number }; child?: unknown }>);

vi.mock("@bastani/atomic-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bastani/atomic-tui")>();
	class FakeTui {
		terminal = { rows: 30 };
		child: unknown;
		constructor() {
			screens.push(this);
		}
		addChild(child: unknown) {
			this.child = child;
		}
		setFocus() {}
		start() {}
		stop() {}
		requestRender() {}
	}
	return { ...actual, ProcessTerminal: class {}, TuiMainScreen: FakeTui };
});

import { selectConfig } from "../src/cli/config-selector.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import type { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.js";

describe("atomic config follows the terminal's height", () => {
	afterEach(() => {
		screens.splice(0);
		setKeybindings(new KeybindingsManager({}));
	});

	it("fits the frame to the rows the terminal has at each render, not the rows it had at launch", async () => {
		const resolved = {
			extensions: Array.from({ length: 43 }, (_, i) => ({
				path: `/x/ext${i}.ts`,
				enabled: true,
				metadata: { source: "auto", scope: "user", origin: "top-level" },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
		const settingsManager = {
			getTheme: () => "dark",
			getTerminalCapabilityOverrides: () => ({}),
		} as unknown as SettingsManager;
		const closed = selectConfig({
			resolvedPaths: { global: resolved, project: resolved } as never,
			settingsManager,
			cwd: "/cwd",
			agentDir: "/agent",
			writeScope: "global",
			projectModeAvailable: false,
		});
		const screen = screens.at(-1);
		assert.ok(screen, "the config screen started");
		const selector = screen.child as ConfigSelectorComponent;
		for (const rows of [30, 10, 16, 8, 40]) {
			screen.terminal.rows = rows;
			const lines = selector.render(80).map((line) => stripTerminalSequences(line));
			assert.ok(lines.length <= rows, `rows=${rows}: ${lines.length} lines`);
			assert.ok(
				lines.some((line) => line.includes("Global resources")),
				`rows=${rows}: header`,
			);
			assert.ok(
				lines.some((line) => line.includes("esc close")),
				`rows=${rows}: key hints`,
			);
		}
		selector.getResourceList().handleInput("\x1b");
		await closed;
	});
});
