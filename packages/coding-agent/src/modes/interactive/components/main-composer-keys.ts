import type { Component } from "@bastani/atomic-tui";
import { panelHintParts, panelHintText } from "../../../core/tasks/agent-panel-rules.ts";
import type { AgentPanelSession } from "../../../core/tasks/agent-panel-source.ts";
import { type AgentPanelCounts, agentPanelCounts } from "../../rpc/agent-panel-bridge.ts";
import { theme } from "../theme/theme.js";
import { isNavHelpKey, type NavKey, type NavKeybindings, navActionText, renderNavKeyOverlay } from "./nav-keys.ts";

export interface MainComposerKeyState {
	/** Every row the panel lists, workflow runs included. */
	readonly agentRows?: number;
	/** The subagent rows among them; defaults to `agentRows`. */
	readonly agents?: number;
	readonly needsInput?: number;
	/** Running background shells, which /tasks lists. */
	readonly shells?: number;
	/** Running background searches, which /tasks lists. */
	readonly searches?: number;
	/** The chat's subagents in /tasks, listed in the panel or not. */
	readonly subagents?: number;
	readonly working: boolean;
}

export type MainComposerHintSource =
	| Pick<MainComposerKeyState, "agentRows" | "agents" | "needsInput" | "shells" | "searches" | "subagents">
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
			return {
				total: source.agentRows,
				agents: source.agents ?? source.agentRows,
				needsInput: source.needsInput ?? 0,
				shells: source.shells ?? 0,
				searches: source.searches ?? 0,
				subagents: source.subagents ?? 0,
			};
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

export function mainComposerHintSegments(
	keybindings: NavKeybindings | undefined,
	state?: MainComposerHintSource,
): string[] {
	const counts = resolveAgentCounts(keybindings, state);
	const promptKeys = promptKeybindings(keybindings);
	const focusKey = navActionText(promptKeys, "app.agents.focus");
	const total = finiteCount(counts.total);
	const parts = panelHintParts(
		{ total, agents: finiteCount(counts.agents ?? total), needsInput: finiteCount(counts.needsInput) },
		{ shells: finiteCount(counts.shells ?? 0), searches: finiteCount(counts.searches ?? 0) },
		finiteCount(counts.subagents ?? 0),
		focusKey !== "",
	);
	const segments = panelHintText(parts, focusKey);
	const help = navActionText(promptKeys, "app.keys.help");
	if (help) segments.push(`${help} keys`);
	return segments;
}

function finiteCount(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
