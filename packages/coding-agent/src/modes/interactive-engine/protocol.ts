import type { CallbackActivity, CallbackActivityKind } from "../../core/callback-activity.ts";

export const INTERACTIVE_ENGINE_PROTOCOL_VERSION = 1;
export const INTERACTIVE_ENGINE_MAX_FRAME_CHARS = 1_048_576;

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

export type InteractiveEngineMessage =
	| { type: "engine_ready"; protocolVersion: typeof INTERACTIVE_ENGINE_PROTOCOL_VERSION; pid: number }
	| { type: "engine_bound" }
	| { type: "engine_heartbeat"; at: number }
	| { type: "engine_activity_started"; activity: CallbackActivity }
	| { type: "engine_activity_finished"; activityId: string }
	| { type: "engine_custom_open"; componentId: string; overlay: boolean; deferInlineCustomUiFocus?: boolean; overlayOptions?: SerializableOverlayOptions }
	| { type: "engine_custom_frame"; componentId: string; requestId: number; lines: string[] }
	| { type: "engine_custom_invalidate"; componentId: string }
	| { type: "engine_custom_done"; componentId: string; result?: JsonValue }
	| { type: "engine_custom_control"; componentId: string; action: "focus" | "hide" | "show" | "unfocus" };

export type InteractiveEngineCommand =
	| { type: "engine_custom_render"; componentId: string; requestId: number; width: number; rows: number }
	| { type: "engine_custom_input"; componentId: string; data: string }
	| { type: "engine_custom_dispose"; componentId: string };

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

function parseJsonObject(line: string): JsonObject | undefined {
	if (line.length > INTERACTIVE_ENGINE_MAX_FRAME_CHARS) return undefined;
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
		case "engine_bound":
			return { type: value.type };
		case "engine_heartbeat":
			return typeof value.at === "number" ? { type: value.type, at: value.at } : undefined;
		case "engine_activity_started":
			return isCallbackActivity(value.activity) ? { type: value.type, activity: value.activity } : undefined;
		case "engine_activity_finished":
			return typeof value.activityId === "string" ? { type: value.type, activityId: value.activityId } : undefined;
		case "engine_custom_open":
			return typeof value.componentId === "string" && typeof value.overlay === "boolean"
				? { type: value.type, componentId: value.componentId, overlay: value.overlay,
					deferInlineCustomUiFocus: value.deferInlineCustomUiFocus === true,
					overlayOptions: isJsonObject(value.overlayOptions) ? value.overlayOptions as SerializableOverlayOptions : undefined }
				: undefined;
		case "engine_custom_frame":
			return typeof value.componentId === "string" && typeof value.requestId === "number" &&
				Array.isArray(value.lines) && value.lines.every((line) => typeof line === "string")
				? { type: value.type, componentId: value.componentId, requestId: value.requestId, lines: value.lines } : undefined;
		case "engine_custom_invalidate":
			return typeof value.componentId === "string" ? { type: value.type, componentId: value.componentId } : undefined;
		case "engine_custom_done":
			return typeof value.componentId === "string"
				? { type: value.type, componentId: value.componentId, result: value.result } : undefined;
		case "engine_custom_control":
			return typeof value.componentId === "string" && ["focus", "hide", "show", "unfocus"].includes(String(value.action))
				? { type: value.type, componentId: value.componentId,
					action: value.action as "focus" | "hide" | "show" | "unfocus" } : undefined;
		default:
			return undefined;
	}
}

export function parseInteractiveEngineCommand(line: string): InteractiveEngineCommand | undefined {
	const value = parseJsonObject(line);
	if (!value || typeof value.type !== "string" || typeof value.componentId !== "string") return undefined;
	if (value.type === "engine_custom_render" && typeof value.requestId === "number" && typeof value.width === "number" && typeof value.rows === "number") {
		return { type: value.type, componentId: value.componentId, requestId: value.requestId, width: value.width, rows: value.rows };
	}
	if (value.type === "engine_custom_input" && typeof value.data === "string") {
		return { type: value.type, componentId: value.componentId, data: value.data };
	}
	return value.type === "engine_custom_dispose" ? { type: value.type, componentId: value.componentId } : undefined;
}

export function serializeInteractiveEngineFrame(message: InteractiveEngineMessage | InteractiveEngineCommand): string {
	const line = JSON.stringify(message);
	if (line.length > INTERACTIVE_ENGINE_MAX_FRAME_CHARS) throw new Error("Interactive engine frame exceeds 1 MiB");
	return `${line}\n`;
}

export const serializeInteractiveEngineMessage = serializeInteractiveEngineFrame;
