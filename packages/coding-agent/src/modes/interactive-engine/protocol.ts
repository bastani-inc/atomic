import type { CallbackActivity, CallbackActivityKind } from "../../core/callback-activity.ts";
import type { HostSessionPickerRow } from "../../core/extensions/ui-types.ts";

export const INTERACTIVE_ENGINE_PROTOCOL_VERSION = 1;
export const INTERACTIVE_ENGINE_MAX_FRAME_BYTES = 1_048_576;

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
 * Allowlisted terminal-mode controls a remote custom component may ask the host
 * to apply to the real host TTY. Deliberately NOT a raw byte channel: the child
 * names an intent and the host owns the concrete escape sequence, so a buggy or
 * compromised child can only toggle these two documented modes.
 */
export type EngineTerminalControl =
	| { kind: "mouse-scroll-tracking"; enabled: boolean }
	| { kind: "autowrap"; enabled: boolean };

export type InteractiveEngineMessage =
	| { type: "engine_ready"; protocolVersion: typeof INTERACTIVE_ENGINE_PROTOCOL_VERSION; pid: number }
	| { type: "engine_bound" }
	| { type: "engine_heartbeat"; at: number }
	| { type: "engine_activity_started"; activity: CallbackActivity }
	| { type: "engine_activity_finished"; activityId: string }
	| { type: "engine_custom_open"; componentId: string; overlay: boolean; deferInlineCustomUiFocus?: boolean; overlayOptions?: SerializableOverlayOptions; widgetKey?: string; widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { type: "engine_custom_close"; componentId: string }
	| { type: "engine_custom_frame"; componentId: string; requestId: number; lines: string[] }
	| { type: "engine_custom_invalidate"; componentId: string }
	| { type: "engine_custom_done"; componentId: string; result?: JsonValue }
	| { type: "engine_custom_terminal"; componentId: string; control: EngineTerminalControl }
	| { type: "engine_custom_control"; componentId: string; action: "focus" | "hide" | "show" | "unfocus" }
	| { type: "engine_session_picker_open"; componentId: string; sessions: HostSessionPickerRow[]; showRenameHint?: boolean }
	| { type: "engine_session_picker_update"; componentId: string; sessions: HostSessionPickerRow[] }
	| { type: "engine_session_picker_error"; componentId: string; message: string }
	| { type: "engine_session_picker_close"; componentId: string };
export type InteractiveEngineCommand =
	| { type: "engine_custom_render"; componentId: string; requestId: number; width: number; rows: number }
	| { type: "engine_custom_input"; componentId: string; data: string }
	| { type: "engine_custom_dispose"; componentId: string }
	| { type: "engine_tool_render"; componentId: string; requestId: number; width: number; toolName: string; toolCallId: string; args: JsonValue; result?: JsonObject; executionStarted: boolean; argsComplete: boolean; isPartial: boolean; expanded: boolean; showImages: boolean; imageWidthCells: number }
	| { type: "engine_message_render"; componentId: string; requestId: number; width: number; message: JsonObject; expanded: boolean }
	| { type: "engine_render_dispose"; componentId: string }
	| { type: "engine_session_picker_select"; componentId: string; path: string }
	| { type: "engine_session_picker_cancel"; componentId: string }
	| { type: "engine_session_picker_delete"; componentId: string; path: string };

const ACTIVITY_KINDS: readonly CallbackActivityKind[] = [
	"extension.hook", "renderer", "tool.execute", "tool.prepare", "workflow.ctx_tool",
	"workflow.run", "workflow.stage_adapter",
];

export function isJsonValue(value: object | boolean | null | number | string): value is JsonValue {
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
	return Object.values(value).every((item) => item !== undefined && isJsonValue(item));
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityKind(value: JsonValue): value is CallbackActivityKind {
	return typeof value === "string" && ACTIVITY_KINDS.includes(value as CallbackActivityKind);
}

function isCallbackActivity(value: JsonValue): value is JsonObject & CallbackActivity {
	return isJsonObject(value) && typeof value.id === "string" && isActivityKind(value.kind) &&
		typeof value.name === "string" && typeof value.startedAt === "number";
}

function parseEngineTerminalControl(value: JsonValue | undefined): EngineTerminalControl | undefined {
	if (value === undefined || !isJsonObject(value) || typeof value.enabled !== "boolean") return undefined;
	if (value.kind === "mouse-scroll-tracking" || value.kind === "autowrap") {
		return { kind: value.kind, enabled: value.enabled };
	}
	return undefined;
}

const SESSION_PICKER_MESSAGE_COLORS = ["success", "warning", "accent", "error"] as const;

function parseSessionPickerRow(value: JsonValue): HostSessionPickerRow | undefined {
	if (!isJsonObject(value)) return undefined;
	const { path, id, cwd, createdAt, modifiedAt, messageCount, firstMessage, allMessagesText, name, messageColor } = value;
	if (typeof path !== "string" || typeof id !== "string" || typeof cwd !== "string" ||
		typeof createdAt !== "number" || typeof modifiedAt !== "number" ||
		typeof messageCount !== "number" || typeof firstMessage !== "string") return undefined;
	if (allMessagesText !== undefined && typeof allMessagesText !== "string") return undefined;
	if (name !== undefined && typeof name !== "string") return undefined;
	if (messageColor !== undefined && !SESSION_PICKER_MESSAGE_COLORS.includes(messageColor as typeof SESSION_PICKER_MESSAGE_COLORS[number])) return undefined;
	return {
		path, id, cwd, createdAt, modifiedAt, messageCount, firstMessage,
		...(allMessagesText !== undefined ? { allMessagesText } : {}),
		...(name !== undefined ? { name } : {}),
		...(messageColor !== undefined ? { messageColor: messageColor as typeof SESSION_PICKER_MESSAGE_COLORS[number] } : {}),
	};
}

function parseSessionPickerRows(value: JsonValue | undefined): HostSessionPickerRow[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: HostSessionPickerRow[] = [];
	for (const entry of value) {
		const row = parseSessionPickerRow(entry);
		if (!row) return undefined;
		rows.push(row);
	}
	return rows;
}

function parseJsonObject(line: string): JsonObject | undefined {
	if (Buffer.byteLength(line, "utf8") > INTERACTIVE_ENGINE_MAX_FRAME_BYTES) return undefined;
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		return undefined;
	}
	return isJsonObject(value) ? value : undefined;
}

export function parseInteractiveEngineMessage(line: string): InteractiveEngineMessage | undefined {
	const value = parseJsonObject(line);
	if (!value || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "engine_ready":
			return value.protocolVersion === INTERACTIVE_ENGINE_PROTOCOL_VERSION && typeof value.pid === "number"
				? { type: value.type, protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: value.pid } : undefined;
		case "engine_bound": return { type: value.type };
		case "engine_heartbeat": return typeof value.at === "number" ? { type: value.type, at: value.at } : undefined;
		case "engine_activity_started": return isCallbackActivity(value.activity) ? { type: value.type, activity: value.activity } : undefined;
		case "engine_activity_finished": return typeof value.activityId === "string" ? { type: value.type, activityId: value.activityId } : undefined;
		case "engine_custom_open":
			return typeof value.componentId === "string" && typeof value.overlay === "boolean"
				? { type: value.type, componentId: value.componentId, overlay: value.overlay,
					deferInlineCustomUiFocus: value.deferInlineCustomUiFocus === true,
					overlayOptions: isJsonObject(value.overlayOptions) ? value.overlayOptions as SerializableOverlayOptions : undefined,
					widgetKey: typeof value.widgetKey === "string" ? value.widgetKey : undefined,
					widgetPlacement: value.widgetPlacement === "belowEditor" ? "belowEditor" : value.widgetPlacement === "aboveEditor" ? "aboveEditor" : undefined }
				: undefined;
		case "engine_custom_close": return typeof value.componentId === "string" ? { type: value.type, componentId: value.componentId } : undefined;
		case "engine_custom_frame":
			return typeof value.componentId === "string" && typeof value.requestId === "number" &&
				Array.isArray(value.lines) && value.lines.every((entry) => typeof entry === "string")
				? { type: value.type, componentId: value.componentId, requestId: value.requestId, lines: value.lines } : undefined;
		case "engine_custom_invalidate": return typeof value.componentId === "string" ? { type: value.type, componentId: value.componentId } : undefined;
		case "engine_custom_done": return typeof value.componentId === "string" ? { type: value.type, componentId: value.componentId, result: value.result } : undefined;
		case "engine_custom_terminal": {
			const control = parseEngineTerminalControl(value.control);
			return typeof value.componentId === "string" && control
				? { type: value.type, componentId: value.componentId, control } : undefined;
		}
		case "engine_custom_control":
			return typeof value.componentId === "string" && ["focus", "hide", "show", "unfocus"].includes(String(value.action))
				? { type: value.type, componentId: value.componentId, action: value.action as "focus" | "hide" | "show" | "unfocus" } : undefined;
		case "engine_session_picker_open": {
			const sessions = parseSessionPickerRows(value.sessions);
			return typeof value.componentId === "string" && sessions &&
				(value.showRenameHint === undefined || typeof value.showRenameHint === "boolean")
				? { type: value.type, componentId: value.componentId, sessions,
					...(typeof value.showRenameHint === "boolean" ? { showRenameHint: value.showRenameHint } : {}) }
				: undefined;
		}
		case "engine_session_picker_update": {
			const sessions = parseSessionPickerRows(value.sessions);
			return typeof value.componentId === "string" && sessions
				? { type: value.type, componentId: value.componentId, sessions } : undefined;
		}
		case "engine_session_picker_error":
			return typeof value.componentId === "string" && typeof value.message === "string"
				? { type: value.type, componentId: value.componentId, message: value.message } : undefined;
		case "engine_session_picker_close":
			return typeof value.componentId === "string" ? { type: value.type, componentId: value.componentId } : undefined;
		default: return undefined;
	}
}

export function parseInteractiveEngineCommand(line: string): InteractiveEngineCommand | undefined {
	const value = parseJsonObject(line);
	if (!value || typeof value.type !== "string" || typeof value.componentId !== "string") return undefined;
	if (value.type === "engine_custom_render" && typeof value.requestId === "number" && typeof value.width === "number" && typeof value.rows === "number") {
		return { type: value.type, componentId: value.componentId, requestId: value.requestId, width: value.width, rows: value.rows };
	}
	if (value.type === "engine_custom_input" && typeof value.data === "string") return { type: value.type, componentId: value.componentId, data: value.data };
	if (value.type === "engine_custom_dispose" || value.type === "engine_render_dispose") return { type: value.type, componentId: value.componentId };
	if ((value.type === "engine_session_picker_select" || value.type === "engine_session_picker_delete") && typeof value.path === "string") {
		return { type: value.type, componentId: value.componentId, path: value.path };
	}
	if (value.type === "engine_session_picker_cancel") return { type: value.type, componentId: value.componentId };
	if (value.type === "engine_tool_render" && typeof value.requestId === "number" && typeof value.width === "number" &&
		typeof value.toolName === "string" && typeof value.toolCallId === "string" && typeof value.executionStarted === "boolean" &&
		typeof value.argsComplete === "boolean" && typeof value.isPartial === "boolean" && typeof value.expanded === "boolean" &&
		typeof value.showImages === "boolean" && typeof value.imageWidthCells === "number") {
		return { type: value.type, componentId: value.componentId, requestId: value.requestId, width: value.width,
			toolName: value.toolName, toolCallId: value.toolCallId, args: value.args, result: isJsonObject(value.result) ? value.result : undefined,
			executionStarted: value.executionStarted, argsComplete: value.argsComplete, isPartial: value.isPartial,
			expanded: value.expanded, showImages: value.showImages, imageWidthCells: value.imageWidthCells };
	}
	if (value.type === "engine_message_render" && typeof value.requestId === "number" && typeof value.width === "number" &&
		isJsonObject(value.message) && typeof value.expanded === "boolean") {
		return { type: value.type, componentId: value.componentId, requestId: value.requestId, width: value.width, message: value.message, expanded: value.expanded };
	}
	return undefined;
}

export function serializeInteractiveEngineFrame(message: InteractiveEngineMessage | InteractiveEngineCommand): string {
	const line = JSON.stringify(message);
	if (Buffer.byteLength(line, "utf8") > INTERACTIVE_ENGINE_MAX_FRAME_BYTES) {
		throw new Error("Interactive engine frame exceeds 1 MiB");
	}
	return `${line}\n`;
}

export const serializeInteractiveEngineMessage = serializeInteractiveEngineFrame;
