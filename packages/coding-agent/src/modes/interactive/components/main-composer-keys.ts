import type { Component } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { isNavHelpKey, type NavKey, type NavKeybindings, navActionText, renderNavKeyOverlay } from "./nav-keys.ts";

export interface MainComposerKeyState {
	readonly working: boolean;
}

export function mainComposerHintSegments(keybindings: NavKeybindings | undefined): string[] {
	const segments: string[] = [];
	const help = navActionText(keybindings, "app.keys.help");
	if (help) segments.push(`${help} keys`);
	return segments;
}

export function mainComposerKeys(state: MainComposerKeyState): NavKey[] {
	return [
		{ keys: "enter", label: "send the prompt" },
		...(state.working ? [{ action: "app.interrupt", label: "interrupt the agent's turn" }] : []),
		{ keys: "/", label: "commands, at the start of the prompt" },
		{ keys: "pgup/pgdn", label: "scroll" },
		{ action: "tui.altScreen.bottom", label: "jump to the latest message" },
		{ action: "app.tools.expand", label: "expand tool output" },
		{ action: "app.thinking.toggle", label: "show or hide thinking" },
		{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
		{ action: "app.keys.help", label: "keys, on an empty prompt" },
	];
}

export class MainComposerKeyOverlay implements Component {
	private readonly keybindings: NavKeybindings | undefined;
	private readonly state: () => MainComposerKeyState;
	private readonly close: () => void;

	constructor(keybindings: NavKeybindings | undefined, state: () => MainComposerKeyState, close: () => void) {
		this.keybindings = keybindings;
		this.state = state;
		this.close = close;
	}

	render(width: number): string[] {
		return renderNavKeyOverlay(
			"keys",
			mainComposerKeys(this.state()),
			width,
			{
				dim: (text) => theme.fg("dim", text),
				text: (text) => theme.fg("text", text),
				muted: (text) => theme.fg("muted", text),
				border: (text) => theme.fg("borderMuted", text),
				bold: (text) => theme.bold(text),
			},
			this.keybindings,
		);
	}

	handleInput(data: string): void {
		if (data === "\x1b" || isNavHelpKey(this.keybindings, data) || this.keybindings?.matches(data, "app.interrupt")) {
			this.close();
		}
	}

	invalidate(): void {}
}
