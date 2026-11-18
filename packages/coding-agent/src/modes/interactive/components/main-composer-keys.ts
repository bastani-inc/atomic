import type { Component } from "@bastani/atomic-tui";
import type { AgentPanelSession } from "../../../core/tasks/agent-panel-source.ts";
import { type AgentPanelCounts, agentPanelCounts } from "../../rpc/agent-panel-bridge.ts";
import { theme } from "../theme/theme.js";
import { panelShellHintSegments } from "./agent-panel.ts";
import { isNavHelpKey, type NavKey, type NavKeybindings, navActionText, renderNavKeyOverlay } from "./nav-keys.ts";

export interface MainComposerKeyState {
	readonly agentRows?: number;
	readonly needsInput?: number;
	/** Running background shells, which /tasks lists. */
	readonly shells?: number;
	readonly working: boolean;
}

export type MainComposerHintSource =
	| Pick<MainComposerKeyState, "agentRows" | "needsInput" | "shells">
	| (AgentPanelSession & object)
	| (() => AgentPanelCounts);

const boundAgentCounts = new WeakMap<NavKeybindings, () => AgentPanelCounts>();

export function bindMainComposerAgentRows(keybindings: NavKeybindings, count: () => AgentPanelCounts): void {
	boundAgentCounts.set(keybindings, count);
}

function resolveAgentCounts(
	keybindings: NavKeybindings | undefined,
	source?: MainComposerHintSource,
): AgentPanelCounts {
	if (typeof source === "function") return source();
	if (source !== undefined) {
		if ("agentRows" in source && typeof source.agentRows === "number") {
			return { total: source.agentRows, needsInput: source.needsInput ?? 0, shells: source.shells ?? 0 };
		}
		return agentPanelCounts(source as AgentPanelSession & object);
	}
	return (keybindings && boundAgentCounts.get(keybindings)?.()) || { total: 0, needsInput: 0 };
}

function promptKeybindings(keybindings: NavKeybindings | undefined): NavKeybindings | undefined {
	if (!keybindings) return undefined;
	return {
		matches: (data, action) => keybindings.matches(data, action),
		getKeys: (action) => {
			const keys = keybindings.getKeys?.(action) ?? [];
			return action === "app.interrupt" ? keys : keys.filter((key) => key !== "esc" && key !== "escape");
		},
	};
}

function agentsSegment(keybindings: NavKeybindings | undefined, rows: number): string | undefined {
	if (!Number.isFinite(rows) || rows <= 0) return undefined;
	const count = Math.floor(rows);
	if (count <= 0) return undefined;
	const key = navActionText(keybindings, "app.agents.focus");
	if (!key) return undefined;
	return `${key} ${count} ${count === 1 ? "agent" : "agents"}`;
}

export function mainComposerHintSegments(
	keybindings: NavKeybindings | undefined,
	state?: MainComposerHintSource,
): string[] {
	const segments: string[] = [];
	const counts = resolveAgentCounts(keybindings, state);
	const promptKeys = promptKeybindings(keybindings);
	const agents = agentsSegment(promptKeys, counts.total);
	if (agents) {
		segments.push(agents);
		if (counts.needsInput > 0) segments.push(`${counts.needsInput} needs input`);
	}
	// Shells are not panel rows; with no panel to focus, say where they are.
	segments.push(...panelShellHintSegments(counts.shells ?? 0, agents !== undefined));
	const help = navActionText(promptKeys, "app.keys.help");
	if (help) segments.push(`${help} keys`);
	return segments;
}

export function mainComposerKeys(state: MainComposerKeyState): NavKey[] {
	const agentRows = state.agentRows ?? 0;
	return [
		{ keys: "enter", label: "send the prompt" },
		...(state.working ? [{ action: "app.interrupt", label: "interrupt the agent's turn" }] : []),
		...(agentRows > 0 ? [{ action: "app.agents.focus", label: "agents, on an empty prompt" }] : []),
		{ keys: "/", label: "commands, at the start of the prompt" },
		{ keys: "@", label: "insert a file path" },
		{ action: "app.history.search", label: "search past prompts" },
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
		const current = this.state();
		const state =
			current.agentRows !== undefined
				? current
				: { ...current, agentRows: resolveAgentCounts(this.keybindings).total };
		return renderNavKeyOverlay(
			"keys",
			mainComposerKeys(state),
			width,
			{
				dim: (text) => theme.fg("dim", text),
				text: (text) => theme.fg("text", text),
				muted: (text) => theme.fg("muted", text),
				border: (text) => theme.fg("borderMuted", text),
				bold: (text) => theme.bold(text),
			},
			promptKeybindings(this.keybindings),
		);
	}

	handleInput(data: string): void {
		if (data === "\x1b" || isNavHelpKey(this.keybindings, data) || this.keybindings?.matches(data, "app.interrupt")) {
			this.close();
		}
	}

	invalidate(): void {}
}
