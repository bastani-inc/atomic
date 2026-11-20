import type { TuiMode } from "@bastani/atomic-tui";
import type { CallbackActivity, CallbackActivityKind } from "../../core/callback-activity.ts";
import { parseSerializedDecisionError, type SerializedDecisionError } from "../../core/decision/errors.js";
import type { UIPromptEndEvent, UIPromptStartEvent } from "../../core/extensions/agent-events.ts";
import type {
	HostInputFormField,
	HostInputFormRequest,
	HostSessionPickerRow,
	WidgetScrollRequest,
	WidgetScrollState,
} from "../../core/extensions/ui-types.js";
import { parseHostSessionPickerRows } from "../../core/host-session-picker-rows.js";
import type { KeyId } from "../../core/keybindings.ts";
import type { SessionTrustDecisions } from "../../core/project-trust-state.ts";
import type { AgentViewState, AgentViewStatus } from "../interactive/agent-view/contracts.ts";
import type { ToolGroupFamily, ToolGroupRole } from "../interactive/components/tool-block.ts";
import { parseTranscriptFrameLayout, type TranscriptFrameLayout } from "./transcript-frame-layout.ts";

/**
 * Version 4 separates minimal session binding from optional resource readiness.
 * A host must not submit a prompt until the matching engine generation reports
 * `engine_resources_ready`.
 */
export const INTERACTIVE_ENGINE_PROTOCOL_VERSION = 4;

export interface JsonObject {
	[key: string]: JsonValue;
}

export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

export interface SerializableOverlayOptions {
	anchor?: string;
	col?: number | string;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	maxHeight?: number | string;
	maxWidth?: number | string;
	minHeight?: number;
	minWidth?: number;
	offsetX?: number;
	offsetY?: number;
	row?: number | string;
	width?: number | string;
}

/**
 * Allowlisted terminal-mode control a remote custom component may ask the host
 * to apply to the real host TTY. Deliberately NOT a raw byte channel: the child
 * names an intent and the host owns the concrete escape sequence, so a buggy or
 * compromised child can only toggle this documented mode.
 */
export type EngineTerminalControl = { kind: "autowrap"; enabled: boolean };

export interface EngineExtensionShortcut {
	key: string;
	description?: string;
	/** Editor-owned input exclusions resolved in the engine and matched by the host. */
	editorKeys?: KeyId[];
}

export type SerializableKeybindingsConfig = Record<string, KeyId | KeyId[]>;

export interface EngineKeybindingState {
	userBindings: SerializableKeybindingsConfig;
	effectiveBindings: SerializableKeybindingsConfig;
	shortcuts: EngineExtensionShortcut[];
}

export type InteractiveEngineMessage =
	| { type: "engine_ready"; protocolVersion: typeof INTERACTIVE_ENGINE_PROTOCOL_VERSION; pid: number }
	| { type: "engine_bound" }
	| { type: "engine_project_trust_resolved" }
	/** A newly registered startup hook can still decline this folder. This is not a session decision. */
	| { type: "engine_project_resources_withheld"; path: string }
	| { type: "engine_trust_decision"; scope: keyof SessionTrustDecisions; path: string; trusted: boolean }
	/** The child recorded `engine_explicit_quit`; it is safe for the host to stop it. */
	| { type: "engine_explicit_quit_ack" }
	/**
	 * The child ran its shutdown after its input ended and is about to exit. What remains is the runtime's own exit
	 * work, such as writing its compile cache, which the host need not wait for.
	 */
	| { type: "engine_shutdown_complete" }
	| { type: "engine_resources_ready" }
	/** `decisionError`: a refused decision-model setting, kept typed so the host can stop as startup does. */
	| { type: "engine_resources_failed"; message: string; decisionError?: SerializedDecisionError }
	| { type: "engine_keybindings_reloaded"; state: EngineKeybindingState }
	/**
	 * The engine retired the session whose extension UI the host mirrors. Sent by the child before the
	 * replacement session binds, on the stream that carries the replacement's `session_start` UI requests,
	 * so the host resets the old UI first and never clears what the new session just set.
	 */
	| { type: "engine_extension_ui_reset" }
	| { type: "engine_heartbeat"; at: number }
	| { type: "engine_activity_started"; activity: CallbackActivity }
	| { type: "engine_activity_finished"; activityId: string }
	| {
			type: "engine_agent_panel_state";
			total: number;
			agents?: number;
			needsInput: number;
			shells?: number;
			subagents?: number;
	  }
	/**
	 * A deprecation warning the engine raised, for the host to show as it shows its own: once per message, and with
	 * `once`, the notice's identity, once across starts.
	 */
	| { type: "engine_deprecation_warning"; message: string; once?: string }
	/** The status of a subagent the host shows on its main screen (view `viewId`), on every change. */
	| { type: "engine_agent_view_status"; viewId: string; status: AgentViewStatus }
	/** The engine's agent panel or `/tasks` asks the host to show a subagent, or main when `taskId` is null. */
	| {
			type: "engine_view_agent";
			taskId: string | null;
			/** The request closes `/tasks`: the host keeps its prompt and panel as painted until the subagent is shown. */
			keepScreen?: true;
	  }
	| { type: "engine_ui_prompt"; event: UIPromptStartEvent | UIPromptEndEvent }
	/**
	 * The child took ownership of a correlated RPC request: it has parsed the
	 * command and is about to run it. Emitted and flushed BEFORE any handler
	 * work, so a later transport failure can be told apart from a send that
	 * never landed. Output is not a substitute: a command can run to completion
	 * with side effects and produce nothing.
	 */
	| { type: "engine_request_accepted"; requestId: string; command: string }
	| {
			type: "engine_custom_open";
			componentId: string;
			overlay: boolean;
			purpose?: "prompt" | "navigation";
			deferInlineCustomUiFocus?: boolean;
			handlesCtrlC?: boolean;
			handlesInternalUiAction?: boolean;
			reserveTranscriptRows?: boolean;
			overlayOptions?: SerializableOverlayOptions;
			blocked?: EngineBlockedStatus;
			widgetKey?: string;
			widgetPlacement?: "aboveEditor" | "belowEditor";
			widgetScroll?: { maxHeight: number; maxHeightFraction?: number };
			/** A viewed subagent's transcript, which the host draws in its transcript area for view `viewId`. */
			placement?: "transcript";
			viewId?: string;
	  }
	| { type: "engine_custom_close"; componentId: string }
	| {
			type: "engine_custom_frame";
			componentId: string;
			requestId: number;
			lines: string[];
			/** For a row's click check, whether changing only its expansion changes these rows. */
			expansionChangesRows?: boolean;
			/** Only sent in response to a historical row asking whether its renderer can be recreated. */
			historyReplayable?: true;
			scrollRequest?: WidgetScrollRequest;
			/** The frame's number, counting the component's frames from 1; a click names the frame it landed on. */
			frame?: number;
			/** What the component reports it drew on each row, for components that name their rows. */
			rowKeys?: string[];
			/** How a viewed subagent's transcript laid out this frame, so the host can place it in another height. */
			layout?: TranscriptFrameLayout;
	  }
	| { type: "engine_custom_input_result"; componentId: string; requestId: number; handled: boolean }
	| { type: "engine_custom_invalidate"; componentId: string }
	| { type: "engine_custom_done"; componentId: string; result?: JsonValue }
	| { type: "engine_custom_terminal"; componentId: string; control: EngineTerminalControl }
	| { type: "engine_custom_copy"; componentId: string; requestId: number; text: string }
	| { type: "engine_custom_control"; componentId: string; action: "focus" | "hide" | "show" | "unfocus" }
	| {
			type: "engine_session_picker_open";
			componentId: string;
			sessions: HostSessionPickerRow[];
			showRenameHint?: boolean;
			title?: string;
			variant?: "sessions" | "runs";
			/** Whether the child handles row deletion; absent means it does (older children). */
			canDelete?: boolean;
	  }
	| { type: "engine_session_picker_update"; componentId: string; sessions: HostSessionPickerRow[] }
	| {
			type: "engine_session_picker_error";
			componentId: string;
			message: string;
			deletePath?: string;
			deleteRequestId?: number;
	  }
	| { type: "engine_session_picker_close"; componentId: string }
	| {
			type: "engine_input_form_open";
			componentId: string;
			title: string;
			fields: HostInputFormField[];
			heading?: string;
			submitLabel?: string;
	  }
	| { type: "engine_input_form_refused"; componentId: string }
	| { type: "engine_input_form_close"; componentId: string };
/**
 * The host is quitting because the user asked to, not because a signal ended the
 * process. The child must acknowledge it (`engine_explicit_quit_ack`) before the host
 * stops it, because stopping closes stdin and sends SIGTERM, which alone cannot tell
 * an explicit quit from a host shutdown caused by a signal. Kept apart from
 * `InteractiveEngineCommand` because it addresses the process, not a UI component.
 */
export interface EngineExplicitQuitCommand {
	type: "engine_explicit_quit";
}

/**
 * The host's chat settings that a transcript inside an engine overlay follows, as the host's own chat does. Every
 * render request carries them, so a toggle in the host reaches the next frame the engine paints.
 */
export interface EngineHostRenderSettings {
	hideThinkingBlock: boolean;
	toolOutputExpanded: boolean;
	fullscreenScrollbar: "auto" | "always" | "hidden";
	fullscreenWheelScrollLines: number | "auto";
}

function parseEngineHostRenderSettings(value: unknown): EngineHostRenderSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { hideThinkingBlock, toolOutputExpanded, fullscreenScrollbar, fullscreenWheelScrollLines } = value as Record<
		string,
		unknown
	>;
	if (typeof hideThinkingBlock !== "boolean" || typeof toolOutputExpanded !== "boolean") return undefined;
	if (fullscreenScrollbar !== "auto" && fullscreenScrollbar !== "always" && fullscreenScrollbar !== "hidden")
		return undefined;
	const wheelLinesValid =
		fullscreenWheelScrollLines === "auto" ||
		(typeof fullscreenWheelScrollLines === "number" &&
			Number.isFinite(fullscreenWheelScrollLines) &&
			fullscreenWheelScrollLines >= 1);
	if (!wheelLinesValid) return undefined;
	return { hideThinkingBlock, toolOutputExpanded, fullscreenScrollbar, fullscreenWheelScrollLines };
}

export type InteractiveEngineCommand =
	| { type: "engine_project_trust_start"; componentId: string; kind: "select" | "confirm" | "input"; title: string }
	| { type: "engine_project_trust_end"; componentId: string }
	| {
			type: "engine_custom_render";
			componentId: string;
			requestId: number;
			width: number;
			rows: number;
			renderSettings?: EngineHostRenderSettings;
			/**
			 * The host renderer's mode, which the component's engine TUI reports as `mode`. Optional: a host that
			 * predates the field omits it, and the engine TUI keeps reporting "regular".
			 */
			hostMode?: TuiMode;
			/** The display's colour depth, sent on the first frame; the engine's stdout is a pipe. */
			colorDepth?: number;
	  }
	/** A key for the component; `hint` when a click on a key hint sent it, which acts whatever the prompt holds. */
	| { type: "engine_custom_input"; componentId: string; requestId: number; data: string; hint?: true }
	/**
	 * A single left click the host drew on the component, at the row and column within it and its drawn size, on the
	 * frame numbered `frame`. A click on a frame the engine has since replaced is dropped.
	 */
	| {
			type: "engine_custom_click";
			componentId: string;
			frame: number;
			/** What the frame drew on the clicked row, for a component that names its rows. */
			rowKey?: string;
			/** The click's number; an `engine_custom_click_settle` with it runs what the click does once it is single. */
			clickId?: number;
			/** The host explicitly cancels every deferred click it does not settle. */
			cancelsClicks?: true;
			x: number;
			y: number;
			width: number;
			height: number;
	  }
	/**
	 * The click numbered `clickId` stayed a single click: the multi-click interval passed with no second press there.
	 * What the component left for that moment, such as expanding a block, runs now. A click that became part of a
	 * double- or triple-click is never settled.
	 */
	| { type: "engine_custom_click_settle" | "engine_custom_click_cancel"; componentId: string; clickId: number }
	| { type: "engine_custom_copy_result"; componentId: string; requestId: number; error?: string }
	| { type: "engine_custom_scroll"; componentId: string; state: WidgetScrollState }
	| { type: "engine_custom_dispose"; componentId: string }
	| {
			type: "engine_tool_render";
			componentId: string;
			requestId: number;
			width: number;
			toolName: string;
			toolCallId: string;
			compareExpansion?: true;
			inspectHistoryReplay?: true;
			rendererTaskId?: string;
			args: JsonValue;
			result?: JsonObject;
			/** Display-only summary for a saved read whose body was too large for its page. */
			savedReadLines?: number | null;
			executionStarted: boolean;
			executionStartedAt?: number;
			argsComplete: boolean;
			isPartial: boolean;
			expanded: boolean;
			showImages: boolean;
			imageWidthCells: number;
			outputPad?: number;
			groupRole?: ToolGroupRole;
	  }
	| {
			type: "engine_message_render";
			componentId: string;
			requestId: number;
			width: number;
			message: JsonObject;
			reopenedStopName?: string;
			expanded: boolean;
			compareExpansion?: true;
			inspectHistoryReplay?: true;
			outputPad: number;
	  }
	| { type: "engine_render_dispose"; componentId: string }
	| { type: "engine_session_picker_select"; componentId: string; path: string }
	| { type: "engine_session_picker_cancel"; componentId: string }
	| { type: "engine_session_picker_delete"; componentId: string; path: string; deleteRequestId?: number }
	| { type: "engine_input_form_submit"; componentId: string; values: Record<string, string> }
	| { type: "engine_input_form_cancel"; componentId: string }
	| { type: "engine_input_form_error"; componentId: string; message: string };

const ACTIVITY_KINDS: readonly CallbackActivityKind[] = ["extension.hook", "renderer", "tool.execute", "tool.prepare"];

export function isJsonValue(value: object | boolean | null | number | string): value is JsonValue {
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
	return Object.values(value).every((item) => item !== undefined && isJsonValue(item));
}

/** Blocked program status an inline custom component reports while visible; see ExtensionUIContext.custom options. */
export type EngineBlockedStatus = { kind: "permission" | "question" | "auth"; message: string };

function parseBlockedStatus(value: JsonValue | undefined): EngineBlockedStatus | undefined {
	if (value === undefined || !isJsonObject(value) || typeof value.message !== "string") return undefined;
	const kind = value.kind;
	return kind === "permission" || kind === "question" || kind === "auth"
		? { kind, message: value.message }
		: undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityKind(value: JsonValue): value is CallbackActivityKind {
	return typeof value === "string" && ACTIVITY_KINDS.includes(value as CallbackActivityKind);
}

function isCallbackActivity(value: JsonValue): value is JsonObject & CallbackActivity {
	return (
		isJsonObject(value) &&
		typeof value.id === "string" &&
		isActivityKind(value.kind) &&
		typeof value.name === "string" &&
		typeof value.startedAt === "number"
	);
}

function parseEngineTerminalControl(value: JsonValue | undefined): EngineTerminalControl | undefined {
	if (value === undefined || !isJsonObject(value) || value.kind !== "autowrap" || typeof value.enabled !== "boolean") {
		return undefined;
	}
	return { kind: "autowrap", enabled: value.enabled };
}

function parseSessionPickerRows(value: JsonValue | undefined): HostSessionPickerRow[] | undefined {
	return parseHostSessionPickerRows(value);
}

const INPUT_FORM_FIELD_TYPES = ["string", "text", "number", "integer", "boolean", "select"] as const;

function parseInputFormFields(value: JsonValue | undefined): HostInputFormField[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const fields: HostInputFormField[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry)) return undefined;
		const { name, type, description, required, choices, placeholder, initialValue } = entry;
		if (
			typeof name !== "string" ||
			!INPUT_FORM_FIELD_TYPES.includes(type as HostInputFormField["type"]) ||
			typeof initialValue !== "string"
		)
			return undefined;
		if (description !== undefined && typeof description !== "string") return undefined;
		if (required !== undefined && typeof required !== "boolean") return undefined;
		if (choices !== undefined && (!Array.isArray(choices) || !choices.every((choice) => typeof choice === "string")))
			return undefined;
		if (placeholder !== undefined && typeof placeholder !== "string") return undefined;
		fields.push({
			name,
			type: type as HostInputFormField["type"],
			initialValue,
			...(typeof description === "string" ? { description } : {}),
			...(typeof required === "boolean" ? { required } : {}),
			...(Array.isArray(choices) ? { choices: choices as string[] } : {}),
			...(typeof placeholder === "string" ? { placeholder } : {}),
		});
	}
	return fields;
}

const TOOL_GROUP_FAMILIES: readonly ToolGroupFamily[] = ["read", "search", "find", "list", "bash"];

function parseToolGroupRole(value: JsonValue | undefined): ToolGroupRole | undefined {
	if (value === undefined || !isJsonObject(value)) return undefined;
	if (value.kind === "standalone" || value.kind === "hidden") return { kind: value.kind };
	if (value.kind !== "head" || !Array.isArray(value.clauses)) return undefined;
	const clauses: { family: ToolGroupFamily; count: number }[] = [];
	for (const clause of value.clauses) {
		if (
			!isJsonObject(clause) ||
			typeof clause.count !== "number" ||
			!Number.isInteger(clause.count) ||
			clause.count < 1
		)
			return undefined;
		const family = TOOL_GROUP_FAMILIES.find((candidate) => candidate === clause.family);
		if (family === undefined) return undefined;
		clauses.push({ family, count: clause.count });
	}
	return clauses.length > 0 ? { kind: "head", clauses } : undefined;
}

function parseStringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
	if (value === undefined || !isJsonObject(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.some(([, entry]) => typeof entry !== "string")) return undefined;
	return Object.fromEntries(entries) as Record<string, string>;
}

function parseKeybindingsConfig(value: JsonValue | undefined): SerializableKeybindingsConfig | undefined {
	if (value === undefined || !isJsonObject(value)) return undefined;
	const config: SerializableKeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") config[key] = binding as SerializableKeybindingsConfig[string];
		else if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as SerializableKeybindingsConfig[string];
		} else return undefined;
	}
	return config;
}

function parseKeybindingState(value: JsonValue | undefined): EngineKeybindingState | undefined {
	if (value === undefined || !isJsonObject(value) || !Array.isArray(value.shortcuts)) return undefined;
	const userBindings = parseKeybindingsConfig(value.userBindings);
	const effectiveBindings = parseKeybindingsConfig(value.effectiveBindings);
	if (!userBindings || !effectiveBindings) return undefined;
	const shortcuts: EngineExtensionShortcut[] = [];
	for (const shortcut of value.shortcuts) {
		if (
			!isJsonObject(shortcut) ||
			typeof shortcut.key !== "string" ||
			(shortcut.description !== undefined && typeof shortcut.description !== "string") ||
			(shortcut.editorKeys !== undefined &&
				(!Array.isArray(shortcut.editorKeys) || shortcut.editorKeys.some((key) => typeof key !== "string")))
		)
			return undefined;
		shortcuts.push({
			key: shortcut.key,
			...(typeof shortcut.description === "string" ? { description: shortcut.description } : {}),
			...(Array.isArray(shortcut.editorKeys) ? { editorKeys: shortcut.editorKeys as KeyId[] } : {}),
		});
	}
	return { userBindings, effectiveBindings, shortcuts };
}

function parseJsonObject(line: string): JsonObject | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		return undefined;
	}
	return isJsonObject(value) ? value : undefined;
}

export function readHostInputFormRequest(request: unknown): HostInputFormRequest | undefined {
	let text: string | undefined;
	try {
		text = JSON.stringify(request);
	} catch {
		return undefined;
	}
	const value = text === undefined ? undefined : parseJsonObject(text);
	return value === undefined ? undefined : parseHostInputFormRequest(value);
}

function parseHostInputFormRequest(value: JsonObject): HostInputFormRequest | undefined {
	const fields = parseInputFormFields(value.fields);
	return typeof value.title === "string" && fields
		? {
				title: value.title,
				fields,
				...(typeof value.heading === "string" ? { heading: value.heading } : {}),
				...(typeof value.submitLabel === "string" ? { submitLabel: value.submitLabel } : {}),
			}
		: undefined;
}

export function parseInteractiveEngineMessage(line: string): InteractiveEngineMessage | undefined {
	const value = parseJsonObject(line);
	if (!value || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "engine_ready":
			return value.protocolVersion === INTERACTIVE_ENGINE_PROTOCOL_VERSION && typeof value.pid === "number"
				? { type: value.type, protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: value.pid }
				: undefined;
		case "engine_bound":
			return { type: value.type };
		case "engine_project_resources_withheld":
			return typeof value.path === "string" ? { type: value.type, path: value.path } : undefined;
		case "engine_trust_decision":
			return (value.scope === "projects" || value.scope === "extensionSources") &&
				typeof value.path === "string" &&
				typeof value.trusted === "boolean"
				? { type: value.type, scope: value.scope, path: value.path, trusted: value.trusted }
				: undefined;
		case "engine_project_trust_resolved":
		case "engine_explicit_quit_ack":
		case "engine_shutdown_complete":
		case "engine_extension_ui_reset":
			return { type: value.type };
		case "engine_resources_ready":
			return { type: value.type };
		case "engine_resources_failed": {
			if (typeof value.message !== "string") return undefined;
			const decisionError = parseSerializedDecisionError(value.decisionError);
			return { type: value.type, message: value.message, ...(decisionError ? { decisionError } : {}) };
		}
		case "engine_keybindings_reloaded": {
			const state = parseKeybindingState(value.state);
			return state ? { type: value.type, state } : undefined;
		}
		case "engine_heartbeat":
			return typeof value.at === "number" ? { type: value.type, at: value.at } : undefined;
		case "engine_deprecation_warning":
			return typeof value.message === "string" && (value.once === undefined || typeof value.once === "string")
				? { type: value.type, message: value.message, ...(value.once === undefined ? {} : { once: value.once }) }
				: undefined;
		case "engine_agent_view_status": {
			const status = parseAgentViewStatus(value.status);
			return typeof value.viewId === "string" && status !== undefined
				? { type: value.type, viewId: value.viewId, status }
				: undefined;
		}
		case "engine_view_agent":
			return typeof value.taskId === "string" || value.taskId === null
				? { type: value.type, taskId: value.taskId, ...(value.keepScreen === true ? { keepScreen: true } : {}) }
				: undefined;
		case "engine_activity_started":
			return isCallbackActivity(value.activity) ? { type: value.type, activity: value.activity } : undefined;
		case "engine_activity_finished":
			return typeof value.activityId === "string" ? { type: value.type, activityId: value.activityId } : undefined;
		case "engine_ui_prompt": {
			const event = value.event;
			if (!event || !isJsonObject(event)) return undefined;
			if (event.type !== "ui_prompt_start" && event.type !== "ui_prompt_end") return undefined;
			if (event.reason !== "ui_prompt" && event.reason !== "project_trust") return undefined;
			if (
				event.kind !== "select" &&
				event.kind !== "confirm" &&
				event.kind !== "input" &&
				event.kind !== "editor" &&
				event.kind !== "custom"
			)
				return undefined;
			if (event.title !== undefined && typeof event.title !== "string") return undefined;
			return {
				type: value.type,
				event: {
					type: event.type,
					reason: event.reason,
					kind: event.kind,
					...(event.title === undefined ? {} : { title: event.title }),
				},
			};
		}
		case "engine_agent_panel_state":
			return typeof value.total === "number" &&
				Number.isSafeInteger(value.total) &&
				value.total >= 0 &&
				typeof value.needsInput === "number" &&
				Number.isSafeInteger(value.needsInput) &&
				value.needsInput >= 0 &&
				value.needsInput <= value.total &&
				(value.shells === undefined ||
					(typeof value.shells === "number" && Number.isSafeInteger(value.shells) && value.shells >= 0)) &&
				(value.subagents === undefined ||
					(typeof value.subagents === "number" &&
						Number.isSafeInteger(value.subagents) &&
						value.subagents >= 0)) &&
				(value.agents === undefined ||
					(typeof value.agents === "number" &&
						Number.isSafeInteger(value.agents) &&
						value.agents >= 0 &&
						value.agents <= value.total))
				? {
						type: value.type,
						total: value.total,
						...(value.agents === undefined ? {} : { agents: value.agents }),
						needsInput: value.needsInput,
						...(value.shells === undefined ? {} : { shells: value.shells }),
						...(value.subagents === undefined ? {} : { subagents: value.subagents }),
					}
				: undefined;
		case "engine_request_accepted":
			return typeof value.requestId === "string" && typeof value.command === "string"
				? { type: value.type, requestId: value.requestId, command: value.command }
				: undefined;
		case "engine_custom_open":
			return typeof value.componentId === "string" && typeof value.overlay === "boolean"
				? {
						type: value.type,
						componentId: value.componentId,
						overlay: value.overlay,
						...(value.purpose === "navigation" || value.purpose === "prompt" ? { purpose: value.purpose } : {}),
						deferInlineCustomUiFocus: value.deferInlineCustomUiFocus === true,
						handlesCtrlC: value.handlesCtrlC === true,
						handlesInternalUiAction: value.handlesInternalUiAction === true,
						reserveTranscriptRows: value.reserveTranscriptRows === true,
						overlayOptions: isJsonObject(value.overlayOptions)
							? (value.overlayOptions as SerializableOverlayOptions)
							: undefined,
						...(parseBlockedStatus(value.blocked) ? { blocked: parseBlockedStatus(value.blocked) } : {}),
						widgetKey: typeof value.widgetKey === "string" ? value.widgetKey : undefined,
						...(isJsonObject(value.widgetScroll) && typeof value.widgetScroll.maxHeight === "number"
							? {
									widgetScroll: {
										maxHeight: value.widgetScroll.maxHeight,
										...(typeof value.widgetScroll.maxHeightFraction === "number"
											? { maxHeightFraction: value.widgetScroll.maxHeightFraction }
											: {}),
									},
								}
							: {}),
						widgetPlacement:
							value.widgetPlacement === "belowEditor"
								? "belowEditor"
								: value.widgetPlacement === "aboveEditor"
									? "aboveEditor"
									: undefined,
						...(value.placement === "transcript" && typeof value.viewId === "string"
							? { placement: "transcript" as const, viewId: value.viewId }
							: {}),
					}
				: undefined;
		case "engine_custom_close":
			return typeof value.componentId === "string"
				? { type: value.type, componentId: value.componentId }
				: undefined;
		case "engine_custom_frame":
			return typeof value.componentId === "string" &&
				typeof value.requestId === "number" &&
				Array.isArray(value.lines) &&
				value.lines.every((entry) => typeof entry === "string")
				? {
						type: value.type,
						componentId: value.componentId,
						requestId: value.requestId,
						lines: value.lines,
						...(value.historyReplayable === true ? { historyReplayable: true } : {}),
						...(typeof value.expansionChangesRows === "boolean"
							? { expansionChangesRows: value.expansionChangesRows }
							: {}),
						...(isCellCount(value.frame) ? { frame: value.frame } : {}),
						...(Array.isArray(value.rowKeys) && value.rowKeys.every((key) => typeof key === "string")
							? { rowKeys: value.rowKeys as string[] }
							: {}),
						...layoutField(value.layout),
						...(isJsonObject(value.scrollRequest) &&
						typeof value.scrollRequest.version === "number" &&
						typeof value.scrollRequest.scrollTop === "number"
							? {
									scrollRequest: {
										version: value.scrollRequest.version,
										scrollTop: value.scrollRequest.scrollTop,
									},
								}
							: {}),
					}
				: undefined;
		case "engine_custom_input_result":
			return typeof value.componentId === "string" &&
				typeof value.requestId === "number" &&
				typeof value.handled === "boolean"
				? { type: value.type, componentId: value.componentId, requestId: value.requestId, handled: value.handled }
				: undefined;
		case "engine_custom_invalidate":
			return typeof value.componentId === "string"
				? { type: value.type, componentId: value.componentId }
				: undefined;
		case "engine_custom_done":
			return typeof value.componentId === "string"
				? { type: value.type, componentId: value.componentId, result: value.result }
				: undefined;
		case "engine_custom_copy":
			return typeof value.componentId === "string" &&
				typeof value.requestId === "number" &&
				typeof value.text === "string"
				? { type: value.type, componentId: value.componentId, requestId: value.requestId, text: value.text }
				: undefined;
		case "engine_custom_terminal": {
			const control = parseEngineTerminalControl(value.control);
			return typeof value.componentId === "string" && control
				? { type: value.type, componentId: value.componentId, control }
				: undefined;
		}
		case "engine_custom_control":
			return typeof value.componentId === "string" &&
				["focus", "hide", "show", "unfocus"].includes(String(value.action))
				? {
						type: value.type,
						componentId: value.componentId,
						action: value.action as "focus" | "hide" | "show" | "unfocus",
					}
				: undefined;
		case "engine_session_picker_open": {
			const sessions = parseSessionPickerRows(value.sessions);
			return typeof value.componentId === "string" &&
				sessions &&
				(value.showRenameHint === undefined || typeof value.showRenameHint === "boolean") &&
				(value.title === undefined || typeof value.title === "string") &&
				(value.variant === undefined || value.variant === "sessions" || value.variant === "runs") &&
				(value.canDelete === undefined || typeof value.canDelete === "boolean")
				? {
						type: value.type,
						componentId: value.componentId,
						sessions,
						...(typeof value.showRenameHint === "boolean" ? { showRenameHint: value.showRenameHint } : {}),
						...(typeof value.title === "string" ? { title: value.title } : {}),
						...(value.variant === "sessions" || value.variant === "runs" ? { variant: value.variant } : {}),
						...(typeof value.canDelete === "boolean" ? { canDelete: value.canDelete } : {}),
					}
				: undefined;
		}
		case "engine_session_picker_update": {
			const sessions = parseSessionPickerRows(value.sessions);
			return typeof value.componentId === "string" && sessions
				? { type: value.type, componentId: value.componentId, sessions }
				: undefined;
		}
		case "engine_session_picker_error":
			return typeof value.componentId === "string" && typeof value.message === "string"
				? {
						type: value.type,
						componentId: value.componentId,
						message: value.message,
						...(typeof value.deletePath === "string" ? { deletePath: value.deletePath } : {}),
						...(typeof value.deleteRequestId === "number" &&
						Number.isSafeInteger(value.deleteRequestId) &&
						value.deleteRequestId > 0
							? { deleteRequestId: value.deleteRequestId }
							: {}),
					}
				: undefined;
		case "engine_session_picker_close":
		case "engine_input_form_close":
			return typeof value.componentId === "string"
				? { type: value.type, componentId: value.componentId }
				: undefined;
		case "engine_input_form_open": {
			if (typeof value.componentId !== "string") return undefined;
			const request = parseHostInputFormRequest(value);
			return request
				? { type: value.type, componentId: value.componentId, ...request }
				: { type: "engine_input_form_refused", componentId: value.componentId };
		}
		default:
			return undefined;
	}
}

export function parseEngineExplicitQuitCommand(line: string): EngineExplicitQuitCommand | undefined {
	return parseJsonObject(line)?.type === "engine_explicit_quit" ? { type: "engine_explicit_quit" } : undefined;
}

function layoutField(value: unknown): { layout?: TranscriptFrameLayout } {
	const layout = parseTranscriptFrameLayout(value);
	return layout === undefined ? {} : { layout };
}

function isCellCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseInteractiveEngineCommand(line: string): InteractiveEngineCommand | undefined {
	const value = parseJsonObject(line);
	if (!value || typeof value.type !== "string" || typeof value.componentId !== "string") return undefined;
	if (value.type === "engine_project_trust_end") return { type: value.type, componentId: value.componentId };
	if (
		value.type === "engine_project_trust_start" &&
		(value.kind === "select" || value.kind === "confirm" || value.kind === "input") &&
		typeof value.title === "string"
	) {
		return { type: value.type, componentId: value.componentId, kind: value.kind, title: value.title };
	}
	if (
		value.type === "engine_custom_scroll" &&
		isJsonObject(value.state) &&
		typeof value.state.scrollTop === "number" &&
		typeof value.state.viewportHeight === "number" &&
		typeof value.state.contentHeight === "number"
	) {
		return {
			type: value.type,
			componentId: value.componentId,
			state: {
				scrollTop: value.state.scrollTop,
				viewportHeight: value.state.viewportHeight,
				contentHeight: value.state.contentHeight,
			},
		};
	}
	if (
		value.type === "engine_custom_render" &&
		typeof value.requestId === "number" &&
		typeof value.width === "number" &&
		typeof value.rows === "number"
	) {
		const renderSettings = parseEngineHostRenderSettings(value.renderSettings);
		const hostMode = value.hostMode === "fullscreen" || value.hostMode === "regular" ? value.hostMode : undefined;
		return {
			type: value.type,
			componentId: value.componentId,
			requestId: value.requestId,
			width: value.width,
			rows: value.rows,
			...(renderSettings === undefined ? {} : { renderSettings }),
			...(value.colorDepth === 1 || value.colorDepth === 4 || value.colorDepth === 8 || value.colorDepth === 24
				? { colorDepth: value.colorDepth }
				: {}),
			...(hostMode === undefined ? {} : { hostMode }),
		};
	}
	if (value.type === "engine_custom_input" && typeof value.requestId === "number" && typeof value.data === "string")
		return {
			type: value.type,
			componentId: value.componentId,
			requestId: value.requestId,
			data: value.data,
			...(value.hint === true ? { hint: true as const } : {}),
		};
	if (
		value.type === "engine_custom_click" &&
		isCellCount(value.frame) &&
		isCellCount(value.x) &&
		isCellCount(value.y) &&
		isCellCount(value.width) &&
		isCellCount(value.height)
	)
		return {
			type: value.type,
			componentId: value.componentId,
			frame: value.frame,
			...(typeof value.rowKey === "string" ? { rowKey: value.rowKey } : {}),
			...(isCellCount(value.clickId) ? { clickId: value.clickId } : {}),
			...(value.cancelsClicks === true ? { cancelsClicks: true } : {}),
			x: value.x,
			y: value.y,
			width: value.width,
			height: value.height,
		};
	if (
		(value.type === "engine_custom_click_settle" || value.type === "engine_custom_click_cancel") &&
		isCellCount(value.clickId)
	)
		return { type: value.type, componentId: value.componentId, clickId: value.clickId };
	if (
		value.type === "engine_custom_copy_result" &&
		typeof value.requestId === "number" &&
		(value.error === undefined || typeof value.error === "string")
	)
		return { type: value.type, componentId: value.componentId, requestId: value.requestId, error: value.error };
	if (value.type === "engine_custom_dispose" || value.type === "engine_render_dispose")
		return { type: value.type, componentId: value.componentId };
	if (
		(value.type === "engine_session_picker_select" || value.type === "engine_session_picker_delete") &&
		typeof value.path === "string"
	) {
		return {
			type: value.type,
			componentId: value.componentId,
			path: value.path,
			...(value.type === "engine_session_picker_delete" &&
			typeof value.deleteRequestId === "number" &&
			Number.isSafeInteger(value.deleteRequestId) &&
			value.deleteRequestId > 0
				? { deleteRequestId: value.deleteRequestId }
				: {}),
		};
	}
	if (value.type === "engine_session_picker_cancel") return { type: value.type, componentId: value.componentId };
	if (value.type === "engine_input_form_cancel") return { type: value.type, componentId: value.componentId };
	if (value.type === "engine_input_form_error" && typeof value.message === "string")
		return { type: value.type, componentId: value.componentId, message: value.message };
	if (value.type === "engine_input_form_submit") {
		const values = parseStringRecord(value.values);
		return values ? { type: value.type, componentId: value.componentId, values } : undefined;
	}
	if (
		value.type === "engine_tool_render" &&
		typeof value.requestId === "number" &&
		typeof value.width === "number" &&
		typeof value.toolName === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.executionStarted === "boolean" &&
		typeof value.argsComplete === "boolean" &&
		typeof value.isPartial === "boolean" &&
		typeof value.expanded === "boolean" &&
		typeof value.showImages === "boolean" &&
		typeof value.imageWidthCells === "number"
	) {
		if (
			value.rendererTaskId !== undefined &&
			(typeof value.rendererTaskId !== "string" ||
				value.rendererTaskId.length === 0 ||
				value.rendererTaskId.length > 256)
		)
			return undefined;
		return {
			type: value.type,
			componentId: value.componentId,
			requestId: value.requestId,
			width: value.width,
			toolName: value.toolName,
			...(value.inspectHistoryReplay === true ? { inspectHistoryReplay: true } : {}),
			...(value.compareExpansion === true ? { compareExpansion: true } : {}),
			...(value.rendererTaskId === undefined ? {} : { rendererTaskId: value.rendererTaskId }),
			toolCallId: value.toolCallId,
			args: value.args,
			result: isJsonObject(value.result) ? value.result : undefined,
			...(value.savedReadLines === null ||
			(typeof value.savedReadLines === "number" &&
				Number.isSafeInteger(value.savedReadLines) &&
				value.savedReadLines >= 0)
				? { savedReadLines: value.savedReadLines }
				: {}),
			executionStarted: value.executionStarted,
			argsComplete: value.argsComplete,
			isPartial: value.isPartial,
			expanded: value.expanded,
			showImages: value.showImages,
			imageWidthCells: value.imageWidthCells,
			outputPad: typeof value.outputPad === "number" ? value.outputPad : undefined,
			executionStartedAt:
				typeof value.executionStartedAt === "number" && Number.isFinite(value.executionStartedAt)
					? value.executionStartedAt
					: undefined,
			groupRole: parseToolGroupRole(value.groupRole),
		};
	}
	if (
		value.type === "engine_message_render" &&
		typeof value.requestId === "number" &&
		typeof value.width === "number" &&
		isJsonObject(value.message) &&
		typeof value.expanded === "boolean" &&
		typeof value.outputPad === "number"
	) {
		return {
			type: value.type,
			componentId: value.componentId,
			requestId: value.requestId,
			width: value.width,
			message: value.message,
			...(value.inspectHistoryReplay === true ? { inspectHistoryReplay: true } : {}),
			...(typeof value.reopenedStopName === "string" ? { reopenedStopName: value.reopenedStopName } : {}),
			...(value.compareExpansion === true ? { compareExpansion: true } : {}),
			expanded: value.expanded,
			outputPad: value.outputPad,
		};
	}
	return undefined;
}

export function serializeInteractiveEngineFrame(
	message: InteractiveEngineMessage | InteractiveEngineCommand | EngineExplicitQuitCommand,
): string {
	return `${JSON.stringify(message)}\n`;
}

export const serializeInteractiveEngineMessage = serializeInteractiveEngineFrame;

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const AGENT_VIEW_STATES: ReadonlySet<string> = new Set<AgentViewState>([
	"running",
	"queued",
	"input",
	"paused",
	"stopping",
	"waiting",
	"done",
	"failed",
	"stopped",
]);

/** `value` as a viewed subagent's status, or undefined when it is not one. */
function parseAgentViewStatus(value: JsonValue | undefined): AgentViewStatus | undefined {
	if (value === undefined || !isJsonObject(value)) return undefined;
	const queued = value.queued;
	const valid =
		typeof value.taskId === "string" &&
		typeof value.agentKey === "string" &&
		typeof value.name === "string" &&
		typeof value.ruleLabel === "string" &&
		typeof value.placeholder === "string" &&
		typeof value.state === "string" &&
		AGENT_VIEW_STATES.has(value.state) &&
		typeof value.busy === "boolean" &&
		typeof value.paused === "boolean" &&
		typeof value.retrying === "boolean" &&
		typeof value.heldPrompt === "boolean" &&
		typeof value.gone === "boolean" &&
		(value.readOnlyReason === undefined || typeof value.readOnlyReason === "string") &&
		(value.working === undefined || (value.working !== null && isJsonObject(value.working))) &&
		queued !== undefined &&
		isJsonObject(queued) &&
		isStringList(queued.steering) &&
		isStringList(queued.followUp);
	return valid ? (value as unknown as AgentViewStatus) : undefined;
}
