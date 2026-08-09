import {
	ProcessTerminal,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMode,
} from "@earendil-works/pi-tui";

export type InteractiveTui = TuiMainScreen | TuiAltScreen;

export interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
}

/** Creates the selected host-side renderer for an interactive session. */
export function createInteractiveTui(options: InteractiveTuiOptions): InteractiveTui {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		// Do not activate model-rendered OSC 8 links from the host process.
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory);
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Keeps existing components pointed at the renderer selected at runtime. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
