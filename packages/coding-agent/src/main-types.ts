import type { Terminal } from "@bastani/atomic-tui";
import type { InlineExtension } from "./core/extensions/types.ts";
import type { InteractiveMode } from "./modes/index.ts";

export interface MainOptions {
	extensionFactories?: InlineExtension[];
	builtinPackagePaths?: string[];
	internalInteractiveHarness?: {
		forceInteractive: true;
		terminal: Terminal;
		onMode?: (mode: InteractiveMode) => void;
	};
}
