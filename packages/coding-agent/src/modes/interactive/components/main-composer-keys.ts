import type { Component } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { isNavHelpKey, type NavKey, type NavKeybindings, navActionText, renderNavKeyOverlay } from "./nav-keys.ts";

/** What the main composer knows when it names its keys. */
export interface MainComposerKeyState {
	/** Rows the agent panel lists; `↓` reaches them only when there are some. */
	readonly agentRows: number;
	/** Whether the chat's agent is working, so Esc interrupts it. */
	readonly working: boolean;
}

/** `↓ 3 agents`, `↓ 1 agent`. */
function agentsSegment(keybindings: NavKeybindings | undefined, rows: number): string | undefined {
	if (rows <= 0) return undefined;
	const key = navActionText(keybindings, "app.agents.focus");
	if (!key) return undefined;
	return `${key} ${rows} ${rows === 1 ? "agent" : "agents"}`;
}

/**
 * The segments the main composer adds to its footer line, after `esc to interrupt` or the model line: the agent
 * panel when it has rows, then the key overlay. An unbound action shows nothing, so the line never names a dead key.
 */
export function mainComposerHintSegments(
	keybindings: NavKeybindings | undefined,
	state: Pick<MainComposerKeyState, "agentRows">,
): string[] {
	const segments: string[] = [];
	const agents = agentsSegment(keybindings, state.agentRows);
	if (agents) segments.push(agents);
	const help = navActionText(keybindings, "app.keys.help");
	if (help) segments.push(`${help} keys`);
	return segments;
}

/** Every key of the main composer, as the `?` overlay lists them. */
export function mainComposerKeys(state: MainComposerKeyState): NavKey[] {
	return [
		{ keys: "enter", label: "send the prompt" },
		...(state.working ? [{ action: "app.interrupt", label: "interrupt the agent's turn" }] : []),
		...(state.agentRows > 0 ? [{ action: "app.agents.focus", label: "agents, on an empty prompt" }] : []),
		{ keys: "/", label: "commands, at the start of the prompt" },
		{ keys: "pgup/pgdn", label: "scroll" },
		{ action: "tui.altScreen.bottom", label: "jump to the latest message" },
		{ action: "app.tools.expand", label: "expand tool output" },
		{ action: "app.thinking.toggle", label: "show or hide thinking" },
		{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
		{ action: "app.keys.help", label: "keys, on an empty prompt" },
	];
}

/** The `?` overlay of the main composer; Esc or `?` closes it. */
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
