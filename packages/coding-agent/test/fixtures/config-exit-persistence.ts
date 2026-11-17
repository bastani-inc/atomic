import { mock } from "bun:test";
import { join } from "node:path";
import { setNativeProcessCreationTimeForTesting, setProcessCreationTimeQueryForTesting } from "../../src/core/process-start-token.js";
import type { SettingsManager } from "../../src/core/settings-manager.js";

const [, , directory, closeKey, queryMode] = process.argv;
process.env.ATOMIC_CODING_AGENT_DIR = join(directory, "agent");
if (process.platform !== "win32") process.env.SystemRoot = directory;
process.chdir(directory);
const tui = await import("@bastani/atomic-tui");
mock.module("@bastani/atomic-tui", () => ({
	...tui,
	ProcessTerminal: class {},
	TuiMainScreen: class {
		terminal = { rows: 24 };
		addChild() {}
		setFocus() {}
		start() {}
		stop() {}
		requestRender() {}
	},
}));
const theme = await import("../../src/modes/interactive/theme/theme.js");
mock.module("../../src/modes/interactive/theme/theme.js", () => ({
	...theme,
	initTheme() {},
	stopThemeWatcher() {},
}));
mock.module("../../src/modes/interactive/components/config-selector.js", () => ({
	ConfigSelectorComponent: class {
		constructor(
			_paths: object,
			settings: SettingsManager,
			_cwd: string,
			_agentDir: string,
			onClose: () => void,
			onExit: () => void,
		) {
			Object.defineProperty(process, "platform", { value: "win32" });
			setNativeProcessCreationTimeForTesting(null);
			if (queryMode !== "powershell") {
				setProcessCreationTimeQueryForTesting({
					file: process.execPath,
					args: () => ["-e", "setInterval(() => {}, 1000)"],
				});
			}
			settings.setExtensionPaths(["-builtin:codemode"]);
			setTimeout(closeKey === "exit" ? onExit : onClose, 100);
		}
		getResourceList() {
			return {};
		}
	},
}));
const { handleConfigCommand } = await import("../../src/package-manager-cli.js");
await handleConfigCommand(["config", "--no-approve"]);
