import { createHash } from "node:crypto";
import type { Component } from "@bastani/atomic-tui";
import type { CustomMessage } from "../../core/messages.ts";
import type { ToolGroupRole } from "../interactive/components/tool-block.ts";
import type { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import { sameToolGroupRole, toolGroupRoleKey } from "../interactive/components/tool-group-tracker.ts";
import { type RowRange, rowsFrom } from "../interactive/components/transcript-block-clicks.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.js";
import type { InteractiveEngineCommand, InteractiveEngineMessage, JsonObject, JsonValue } from "./protocol.ts";
import { RemoteFrameWidthClamp } from "./remote-frame-clamp.ts";

type RenderableToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type RemoteRenderCommand = Extract<InteractiveEngineCommand, { type: "engine_tool_render" | "engine_message_render" }>;

let nextRemoteRendererId = 0;
let nextRuntimeScopeId = 0;
const runtimeScopeIds = new WeakMap<IsolatedInteractiveRuntime, number>();

function runtimeFrameScope(runtime: IsolatedInteractiveRuntime): string {
	let id = runtimeScopeIds.get(runtime);
	if (id === undefined) {
		id = ++nextRuntimeScopeId;
		runtimeScopeIds.set(runtime, id);
	}
	let sessionId: string | undefined;
	try {
		sessionId = runtime.session.sessionManager.getSessionId();
	} catch {
		sessionId = undefined;
	}
	return JSON.stringify([id, sessionId]);
}

/** A row the engine has not rendered yet draws nothing, rather than a placeholder that flickers in and out. */
const NOT_RENDERED_YET: string[] = [];

/**
 * How many rows' last frames are kept, by row identity (a tool call, a custom message), to repaint rebuilt rows. A chat
 * rebuild (compaction, `/reload`, a switched session) recreates every row, and each new row waits for the engine to
 * render it. Showing the row's last frame meanwhile keeps the rebuilt chat painted, instead of a screen of placeholders
 * that lasts as long as the engine is busy.
 */
export const REMOTE_FRAME_CACHE_LIMIT = 2_000;
const recentFrames = new Map<string, string[]>();

function rememberFrame(key: string, lines: string[]): void {
	recentFrames.delete(key);
	recentFrames.set(key, lines);
	if (recentFrames.size > REMOTE_FRAME_CACHE_LIMIT) {
		const oldest = recentFrames.keys().next().value;
		if (oldest !== undefined) recentFrames.delete(oldest);
	}
}

/** One engine-message subscription per runtime, routed by component id, however many rows the chat holds. */
const routesByRuntime = new WeakMap<IsolatedInteractiveRuntime, Map<string, RemoteRenderer>>();

function rendererRoutes(runtime: IsolatedInteractiveRuntime): Map<string, RemoteRenderer> {
	let routes = routesByRuntime.get(runtime);
	if (routes === undefined) {
		const created = new Map<string, RemoteRenderer>();
		runtime.onEngineMessage((message) => {
			if ("componentId" in message) created.get(message.componentId)?.receive(message);
		});
		routesByRuntime.set(runtime, created);
		routes = created;
	}
	return routes;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function jsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	const encoded = JSON.stringify(value);
	return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
}

abstract class RemoteRenderer implements Component {
	protected readonly componentId = `remote_renderer_${++nextRemoteRendererId}`;
	private lines = NOT_RENDERED_YET;
	private width = 0;
	private requestId = 0;
	private appliedRequestId = 0;
	private dirty = true;
	private disposed = false;
	private readonly frameClamp = new RemoteFrameWidthClamp();
	private readonly routes: Map<string, RemoteRenderer>;
	/**
	 * What each unanswered request showed (its frame identity, expansion included), by request id. A frame is
	 * remembered under the identity of the request it answers, not under the row's state when it arrives: a row
	 * collapsed while its expanded frame was in flight must not have that frame remembered as its collapsed one.
	 */
	private readonly requestIdentities = new Map<number, string>();
	private readonly requestScopes = new Map<number, string>();
	private lastScope: string | undefined;
	/**
	 * Clicks' expansion waiting for the engine to draw it: the rows shown and the expansion before the first of them, the
	 * last request sent before the latest of them, the expansion they asked for, and what to do once the first frame
	 * drawn after that shows whether the rows changed.
	 */
	private clickFrame:
		| {
				readonly before: readonly string[];
				readonly from: boolean;
				readonly after: number;
				readonly expanded: boolean;
				changed(): void;
		  }
		| undefined;

	protected readonly runtime: IsolatedInteractiveRuntime;
	private readonly requestRender: () => void;

	constructor(runtime: IsolatedInteractiveRuntime, requestRender: () => void) {
		this.runtime = runtime;
		this.requestRender = requestRender;
		this.routes = rendererRoutes(runtime);
		this.routes.set(this.componentId, this);
	}

	/** An engine message addressed to this row. */
	receive(message: InteractiveEngineMessage): void {
		if (message.type === "engine_custom_frame") {
			if (message.requestId < this.appliedRequestId) return;
			const identity = this.requestIdentities.get(message.requestId);
			const scope = this.requestScopes.get(message.requestId);
			if (identity === undefined || scope === undefined) return;
			for (const requestId of this.requestIdentities.keys()) {
				if (requestId > message.requestId) continue;
				this.requestIdentities.delete(requestId);
				this.requestScopes.delete(requestId);
			}
			rememberFrame(identity, message.lines);
			if (scope !== runtimeFrameScope(this.runtime)) return;
			this.appliedRequestId = message.requestId;
			const clicked = this.clickFrame;
			if (clicked !== undefined && message.requestId > clicked.after) {
				this.clickFrame = undefined;
				// Decided before the new rows are painted, so a held view keeps the block where the reader clicked it. Clicks
				// that toggled the row back to where it started changed nothing.
				if (clicked.expanded !== clicked.from) {
					if (sameLines(clicked.before, message.lines)) this.setExpanded(clicked.from);
					else clicked.changed();
				}
			}
			this.lines = message.lines;
			this.requestRender();
		} else if (message.type === "engine_custom_invalidate") {
			this.changed();
		}
	}

	render(width: number): string[] {
		const scope = runtimeFrameScope(this.runtime);
		if (scope !== this.lastScope) {
			this.lastScope = scope;
			this.lines = NOT_RENDERED_YET;
			this.dirty = true;
		}
		if (!this.disposed && (this.dirty || width !== this.width)) {
			this.width = width;
			this.dirty = false;
			// A row rebuilt for a row the engine already rendered paints its last frame until the fresh one arrives.
			const identity = JSON.stringify([scope, this.frameIdentity()]);
			if (this.lines === NOT_RENDERED_YET) this.lines = recentFrames.get(identity) ?? NOT_RENDERED_YET;
			this.requestIdentities.set(++this.requestId, identity);
			this.requestScopes.set(this.requestId, scope);
			this.runtime.sendEngineCommand(this.command(this.requestId, width));
		}
		// The engine child re-renders asynchronously; until the fresh frame
		// arrives, the previous frame may be wrapped for an older terminal
		// width. Clamp so a resize never replays overflowing lines (pi-tui
		// crashes on any rendered line wider than the terminal).
		return this.frameClamp.clamp(this.lines, width);
	}

	invalidate(): void {
		this.markDirty();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.routes.get(this.componentId) === this) this.routes.delete(this.componentId);
		this.requestIdentities.clear();
		this.requestScopes.clear();
		this.runtime.sendEngineCommand({ type: "engine_render_dispose", componentId: this.componentId });
	}

	protected changed(): void {
		this.markDirty();
		this.requestRender();
	}

	abstract isExpanded(): boolean;
	abstract setExpanded(expanded: boolean): void;

	/**
	 * Sets the expansion a click asked for, and decides once the engine draws it: `changed` runs when the rows differ
	 * from the ones shown before, and otherwise the row goes back to the expansion it had. A click that settles while an
	 * earlier one still waits for its frame takes over from it, measured against the rows shown before the earlier one.
	 */
	expandByClick(expanded: boolean, changed: () => void): void {
		const waiting = this.clickFrame;
		this.clickFrame = {
			before: waiting?.before ?? this.lines,
			from: waiting?.from ?? this.isExpanded(),
			after: this.requestId,
			expanded,
			changed,
		};
		this.setExpanded(expanded);
	}

	protected abstract command(requestId: number, width: number): RemoteRenderCommand;

	/** Names what this row shows, the same for every row recreated for it. */
	protected abstract frameIdentity(): string;

	private markDirty(): void {
		this.dirty = true;
	}
}

/**
 * Disposes the rows rendered by the engine among `components`, which a cleared chat no longer shows: each one
 * otherwise keeps its renderer alive in the engine for the rest of the session.
 */
export function disposeRemoteRenderers(components: readonly Component[]): void {
	for (const component of components) if (component instanceof RemoteRenderer) component.dispose();
}

export class RemoteToolExecutionComponent extends RemoteRenderer {
	readonly expandsOnClick = true;
	private readonly toolName: string;
	private readonly toolCallId: string;
	private readonly rendererTaskId: string | undefined;
	private args: unknown;
	private result: RenderableToolResult | undefined;
	private executionStarted = false;
	private executionStartedAt: number | undefined;
	private argsComplete = false;
	private groupRole: ToolGroupRole = { kind: "standalone" };
	private isPartial = true;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: { showImages?: boolean; imageWidthCells?: number; outputPad?: number; rendererTaskId?: string },
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
	) {
		super(runtime, requestRender);
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.rendererTaskId = options.rendererTaskId;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.changed();
	}
	updateArgs(args: unknown): void {
		this.args = args;
		this.changed();
	}
	markExecutionStarted(startedAt?: number): void {
		if (this.executionStarted) return;
		this.executionStarted = true;
		this.executionStartedAt = startedAt ?? Date.now();
		this.changed();
	}
	setArgsComplete(): void {
		if (this.argsComplete) return;
		this.argsComplete = true;
		this.changed();
	}
	setGroupRole(role: ToolGroupRole): void {
		if (sameToolGroupRole(this.groupRole, role)) return;
		this.groupRole = role;
		this.changed();
	}
	override render(width: number): string[] {
		if (!this.expanded && this.groupRole.kind === "hidden") return [];
		return super.render(width);
	}
	updateResult(result: RenderableToolResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		this.changed();
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.changed();
	}
	isExpanded(): boolean {
		return this.expanded;
	}
	getGroupRole(): ToolGroupRole {
		return this.groupRole;
	}
	/** Every row of the block: the engine draws it as `ToolExecutionComponent` does, after a blank row. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}
	setShowImages(show: boolean): void {
		this.showImages = show;
		this.changed();
	}
	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.changed();
	}

	protected command(requestId: number, width: number): RemoteRenderCommand {
		return {
			type: "engine_tool_render",
			componentId: this.componentId,
			requestId,
			width,
			toolName: this.toolName,
			toolCallId: this.toolCallId,
			...(this.rendererTaskId === undefined ? {} : { rendererTaskId: this.rendererTaskId }),
			args: jsonValue(this.args),
			result: this.result ? (jsonValue(this.result) as JsonObject) : undefined,
			executionStarted: this.executionStarted,
			...(this.executionStartedAt === undefined ? {} : { executionStartedAt: this.executionStartedAt }),
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			imageWidthCells: this.imageWidthCells,
			outputPad: this.outputPad,
			...(this.groupRole.kind === "standalone" ? {} : { groupRole: this.groupRole }),
		};
	}

	protected frameIdentity(): string {
		return JSON.stringify([
			"tool",
			this.rendererTaskId,
			this.toolName,
			this.toolCallId,
			this.expanded,
			toolGroupRoleKey(this.groupRole),
		]);
	}
}

export class RemoteCustomMessageComponent extends RemoteRenderer {
	readonly ownsLeadingSpacer = true;
	private readonly message: CustomMessage<unknown>;
	private contentDigest: string | undefined;
	private expanded = false;
	private outputPad: number;
	constructor(
		message: CustomMessage<unknown>,
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
		outputPad = 1,
	) {
		super(runtime, requestRender);
		this.message = message;
		this.outputPad = outputPad;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.changed();
	}
	/**
	 * A message expands on a click, as Ctrl+O expands it: the engine draws its card, and a card with nothing more to
	 * show stays as it is.
	 */
	readonly expandsOnClick = true;
	isExpanded(): boolean {
		return this.expanded;
	}
	/** Every row of the card: the engine draws it after the blank row it leads with. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.changed();
	}

	protected command(requestId: number, width: number): RemoteRenderCommand {
		return {
			type: "engine_message_render",
			componentId: this.componentId,
			requestId,
			width,
			message: jsonValue(this.message) as JsonObject,
			expanded: this.expanded,
			outputPad: this.outputPad,
		};
	}

	protected frameIdentity(): string {
		// Not the timestamp: a message shown live and the same message restored from the session can differ in it.
		this.contentDigest ??= createHash("sha1")
			.update(JSON.stringify([this.message.content, this.message.details]) ?? "")
			.digest("base64");
		return JSON.stringify(["message", this.message.customType, this.contentDigest, this.expanded]);
	}
}
