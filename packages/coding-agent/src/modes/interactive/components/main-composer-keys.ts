import { type Component, clickableKeysHint, stripHintMarkers } from "@bastani/atomic-tui";
import { panelHintParts, panelHintSegments } from "../../../core/tasks/agent-panel-rules.ts";
import type { AgentPanelSession } from "../../../core/tasks/agent-panel-source.ts";
import { type AgentPanelCounts, agentPanelCounts } from "../../rpc/agent-panel-bridge.ts";
import { theme } from "../theme/theme.js";
import type { FooterHints } from "./footer.ts";
import {
	isNavHelpKey,
	type NavKey,
	type NavKeybindings,
	navEntryKeyParts,
	renderNavKeyOverlay,
	slashCommandHint,
} from "./nav-keys.ts";

export interface MainComposerKeyState {
	/** Every row the panel lists. */
	readonly agentRows?: number;
	/** The subagent rows among them; defaults to `agentRows`. */
	readonly agents?: number;
	readonly needsInput?: number;
	/** Running background shells, which /tasks lists. */
	readonly shells?: number;
	/** The chat's subagents in /tasks, listed in the panel or not. */
	readonly subagents?: number;
	/** The agent the prompt writes to works: the main chat's, or the shown subagent's. */
	readonly working: boolean;
	/** While a subagent is shown: the keys that lead back to main from its empty prompt. Esc pauses it there. */
	readonly viewedAgent?: { readonly backKeys: readonly string[] };
}

/** A way back from the prompt: the keys that take it there now, and where they lead. */
export interface ComposerBackHint {
	readonly keys: readonly string[];
	readonly label: string;
}

export type MainComposerHintSource =
	| Pick<MainComposerKeyState, "agentRows" | "agents" | "needsInput" | "shells" | "subagents">
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

/** The plain text of {@link mainComposerHints}. */
export function mainComposerHintSegments(
	keybindings: NavKeybindings | undefined,
	state?: MainComposerHintSource,
	back?: ComposerBackHint,
): string[] {
	return mainComposerHints(keybindings, state, back).map(stripHintMarkers);
}

/**
 * The hint segments the main chat shows by its prompt: `↓ N agents` and the counts of what the panel lists, `/tasks to
 * manage` when the panel has nothing to focus, and `? keys`. With `back`, the way back leads them, such as `← main chat`
 * while a subagent is shown. A click on a key's segment presses the key, and a click on the `/tasks` segment runs the
 * command.
 */
export function mainComposerHints(
	keybindings: NavKeybindings | undefined,
	state?: MainComposerHintSource,
	back?: ComposerBackHint,
): string[] {
	return mainComposerFooterHints(keybindings, state, back).segments;
}

/** `keys` joined as a hint names them (`←`, `h/←`), each part pressing its own key; empty for no keys. */
function keyListParts(keys: readonly string[]) {
	return navEntryKeyParts({ matches: () => false, getKeys: () => keys }, { action: "app.nav.back", label: "" });
}

export function mainComposerFooterHints(
	keybindings: NavKeybindings | undefined,
	state?: MainComposerHintSource,
	back?: ComposerBackHint,
): FooterHints {
	const counts = resolveAgentCounts(keybindings, state);
	const promptKeys = promptKeybindings(keybindings);
	const focusKeys = navEntryKeyParts(promptKeys, { action: "app.agents.focus", label: "" });
	const focusKey = focusKeys.map((part) => part.text).join("");
	const total = finiteCount(counts.total);
	const parts = panelHintParts(
		{ total, agents: finiteCount(counts.agents ?? total), needsInput: finiteCount(counts.needsInput) },
		finiteCount(counts.shells ?? 0),
		finiteCount(counts.subagents ?? 0),
		focusKey !== "",
	);
	const segments = panelHintSegments(parts, focusKey).map((segment) => {
		if (segment.kind === "agents") return clickableKeysHint(focusKeys, segment.text.slice(focusKey.length));
		if (segment.kind === "tasks") return slashCommandHint(segment.text);
		return segment.text;
	});
	const helpKeys = navEntryKeyParts(promptKeys, { action: "app.keys.help", label: "" });
	if (helpKeys.length > 0) segments.push(clickableKeysHint(helpKeys, " keys"));
	const backKeys = keyListParts(back?.keys ?? []);
	if (back !== undefined && backKeys.length > 0) segments.unshift(clickableKeysHint(backKeys, ` ${back.label}`));
	return { segments };
}

function finiteCount(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function mainComposerKeys(state: MainComposerKeyState): NavKey[] {
	const agentRows = state.agentRows ?? 0;
	const back = keyListParts(state.viewedAgent?.backKeys ?? [])
		.map((part) => part.text)
		.join("");
	return [
		{ keys: "enter", label: "send the prompt" },
		...(back ? [{ keys: back, label: "main chat, on an empty prompt" }] : []),
		...(state.working
			? [
					{
						action: "app.interrupt",
						label: state.viewedAgent ? "pause the agent's turn" : "interrupt the agent's turn",
					},
				]
			: []),
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
