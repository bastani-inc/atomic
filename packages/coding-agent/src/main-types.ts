import type { Terminal } from "@earendil-works/pi-tui";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import type { InteractiveMode } from "./modes/index.ts";

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
	builtinPackagePaths?: string[];
	internalInteractiveHarness?: {
		forceInteractive: true;
		terminal: Terminal;
		onMode?: (mode: InteractiveMode) => void;
	};
}
