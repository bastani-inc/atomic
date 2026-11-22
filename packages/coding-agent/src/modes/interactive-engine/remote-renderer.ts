import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type { Component } from "@bastani/atomic-tui";
import type { CustomMessage } from "../../core/messages.ts";
import { savedReadLines } from "../../core/storage/session/saved-read-summary.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import { reopenedCompletionName } from "../../core/tasks/reopened-completion.js";
import { type KeptTaskAction, keptTaskId } from "../interactive/components/kept-task.ts";
import type { ToolGroupRole } from "../interactive/components/tool-block.ts";
import type { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import {
	drawsApartFromGroup,
	sameToolGroupRole,
	type ToolGroupHead,
	toolGroupRoleKey,
} from "../interactive/components/tool-group-tracker.ts";
import { type RowRange, rowsFrom, sameRows } from "../interactive/components/transcript-block-clicks.ts";
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

interface RendererRoutes {
	rows: Map<string, RemoteRenderer>;
	clicks: AbortController;
}

/** One subscription per runtime, routed by component id, however many rows the chat holds. */
const routesByRuntime = new WeakMap<IsolatedInteractiveRuntime, RendererRoutes>();

function rendererRoutes(runtime: IsolatedInteractiveRuntime): RendererRoutes {
	let routes = routesByRuntime.get(runtime);
	if (routes === undefined) {
		const created: RendererRoutes = { rows: new Map(), clicks: new AbortController() };
		runtime.onGenerationEnded?.(({ generation }) => {
			if (generation === runtime.getEngineGeneration()) created.clicks.abort();
		});
		runtime.onEngineMessage((message) => {
			if (message.type === "engine_bound" && created.clicks.signal.aborted) created.clicks = new AbortController();
			if (message.type === "engine_resources_ready") {
				const scopePrefix = JSON.stringify([runtimeFrameScope(runtime), ""]).slice(0, -3);
				for (const key of [...recentFrames.keys()]) {
					if (key.startsWith(scopePrefix)) recentFrames.delete(key);
				}
				for (const [componentId, row] of created.rows) {
					row.receive({ type: "engine_custom_invalidate", componentId });
				}
			}
			if ("componentId" in message) created.rows.get(message.componentId)?.receive(message);
		});
		routesByRuntime.set(runtime, created);
		routes = created;
	}
	return routes;
}

function jsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	const encoded = JSON.stringify(value);
	return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
}

const remoteRows = new WeakSet<Component>();
/** Identify our renderer without walking an opaque extension widget's prototype chain. */
export function remoteHistoryRow(component: Component): RemoteRenderer | undefined {
	return remoteRows.has(component) ? (component as RemoteRenderer) : undefined;
}
abstract class RemoteRenderer implements Component {
	readonly selectionTextMayChangeOnReplay = true;
	private inspectHistoryReplay = false;
	private canReplay = false;
	private releaseIfRetired?: () => void;
	get historyReplayable(): boolean {
		this.inspectHistoryReplay = true;
		return this.canReplay;
	}
	onReplayabilityChange(release: () => void): void {
		this.releaseIfRetired = release;
	}
	get unrendered(): boolean {
		return this.requestId === 0;
	}
	protected readonly componentId = `remote_renderer_${++nextRemoteRendererId}`;
	private lines = NOT_RENDERED_YET;
	private width = 0;
	private requestId = 0;
	private appliedRequestId = 0;
	private dirty = true;
	private disposed = false;
	private readonly frameClamp = new RemoteFrameWidthClamp();
	private readonly routes: RendererRoutes;
	/**
	 * What each unanswered request showed (its frame identity, expansion included), by request id. A frame is
	 * remembered under the identity of the request it answers, not under the row's state when it arrives: a row
	 * collapsed while its expanded frame was in flight must not have that frame remembered as its collapsed one.
	 */
	private readonly requestIdentities = new Map<number, string>();
	private readonly requestScopes = new Map<number, string>();
	private lastScope: string | undefined;
	/** Each settled click compares both expansions at its own width and data revision. Only the front request is in flight. */
	private readonly clickChecks: { command: RemoteRenderCommand; baseline?: string[]; changed(): void }[] = [];
	private toggleAfterChecks = false;
	private clickCancellation?: AbortSignal;
	/** The latest state is owed to the engine once the click comparison under way ends (see sendLatestState). */
	private latestStateOwed = false;
	protected expanded = false;

	protected readonly runtime: IsolatedInteractiveRuntime;
	private readonly requestRender: () => void;

	constructor(runtime: IsolatedInteractiveRuntime, requestRender: () => void) {
		this.runtime = runtime;
		this.requestRender = requestRender;
		remoteRows.add(this);
		this.routes = rendererRoutes(runtime);
		this.routes.rows.set(this.componentId, this);
	}

	/** An engine message addressed to this row. */
	receive(message: InteractiveEngineMessage): void {
		if (message.type === "engine_custom_frame") {
			const check = this.clickChecks[0];
			if (check && message.requestId === check.command.requestId) {
				if (runtimeFrameScope(this.runtime) !== this.lastScope) {
					this.clearClickChecks();
					return;
				}
				// An older engine sends only the requested rows. Ask it for the other expansion of the same snapshot.
				if (message.expansionChangesRows === undefined && check.baseline === undefined) {
					check.baseline = message.lines;
					check.command = { ...check.command, requestId: ++this.requestId, expanded: !check.command.expanded };
					this.runtime.sendEngineCommand(check.command);
					return;
				}
				if (message.expansionChangesRows ?? !sameRows(check.baseline!, message.lines)) {
					this.toggleAfterChecks = !this.toggleAfterChecks;
				}
				this.clickChecks.shift();
				const next = this.clickChecks[0];
				if (next) this.runtime.sendEngineCommand(next.command);
				else {
					if (this.toggleAfterChecks) {
						this.setExpanded(!this.expanded);
						check.changed();
					} else {
						this.clearClickChecks();
						this.changed();
					}
				}
				return;
			}
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
			this.canReplay = message.historyReplayable === true;
			this.lines = message.lines;
			if (this.canReplay) this.releaseIfRetired?.();
			this.requestRender();
		} else if (message.type === "engine_custom_invalidate") {
			this.changed();
		}
	}

	render(width: number): string[] {
		const scope = runtimeFrameScope(this.runtime);
		if (scope !== this.lastScope) {
			this.lastScope = scope;
			this.clearClickChecks();
			this.lines = NOT_RENDERED_YET;
			this.dirty = true;
		}
		if (width !== this.width) {
			this.width = width;
			this.dirty = true;
		}
		// Render requests for the same row are coalesced in transit. Do not overwrite an outstanding click check.
		if (!this.disposed && !this.routes.clicks.signal.aborted && this.dirty && this.clickChecks.length === 0) {
			this.dirty = false;
			// A row rebuilt for a row the engine already rendered paints its last frame until the fresh one arrives.
			const identity = JSON.stringify([scope, this.frameIdentity()]);
			if (this.lines === NOT_RENDERED_YET) this.lines = recentFrames.get(identity) ?? NOT_RENDERED_YET;
			this.requestIdentities.set(++this.requestId, identity);
			this.requestScopes.set(this.requestId, scope);
			const request = this.command(this.requestId, width);
			this.runtime.sendEngineCommand(
				this.inspectHistoryReplay ? { ...request, inspectHistoryReplay: true } : request,
			);
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
		this.releaseIfRetired = undefined;
		if (this.routes.rows.get(this.componentId) === this) this.routes.rows.delete(this.componentId);
		this.requestIdentities.clear();
		this.requestScopes.clear();
		this.clearClickChecks();
		this.runtime.sendEngineCommand({ type: "engine_render_dispose", componentId: this.componentId });
	}

	protected changed(): void {
		this.markDirty();
		this.requestRender();
	}

	/**
	 * Gives the engine this row's latest state at the width it was last drawn, also while the screen does not draw the
	 * row (its chat is hidden, or its group folded): the engine draws a call it last saw running as running, and keeps
	 * animating it, until a frame request tells it the call settled.
	 */
	protected sendLatestState(): void {
		if (this.requestId === 0 || this.disposed) return;
		// A click's comparison of the two expansions is under way: the state goes once it ends, however it ends.
		if (this.clickChecks.length > 0) {
			this.latestStateOwed = true;
			return;
		}
		if (!this.dirty) return;
		RemoteRenderer.prototype.render.call(this, this.width);
	}

	private readonly cancelClickChecks = (): void => {
		this.clearClickChecks();
		this.requestRender();
	};

	private readonly clearClickChecks = (): void => {
		this.clickCancellation?.removeEventListener("abort", this.cancelClickChecks);
		this.clickCancellation = undefined;
		this.clickChecks.length = 0;
		this.toggleAfterChecks = false;
		this.markDirty();
		if (this.latestStateOwed) {
			this.latestStateOwed = false;
			// Once whatever ended the comparison (an expansion it decided, a cancel) has run.
			queueMicrotask(() => this.sendLatestState());
		}
	};

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		this.clearClickChecks(); // An explicit expansion, e.g. Ctrl+O, supersedes outstanding clicks.
		this.expanded = expanded;
		this.changed();
	}

	expandByClick(expanded: boolean, changed: () => void, width = this.width, signal?: AbortSignal): void {
		if (this.disposed || signal?.aborted || this.routes.clicks.signal.aborted || expanded === this.expanded) return;
		const command = { ...this.command(++this.requestId, width), compareExpansion: true as const };
		this.clickChecks.push({ command, changed });
		if (this.clickChecks.length === 1) {
			this.clickCancellation = signal
				? AbortSignal.any([signal, this.routes.clicks.signal])
				: this.routes.clicks.signal;
			this.clickCancellation.addEventListener("abort", this.cancelClickChecks, { once: true });
			this.runtime.sendEngineCommand(command);
		}
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
	/** What the chat showing this row offers for a task its call left running; see `ToolExecutionOptions.keptTaskAction`. */
	private readonly keptTaskAction: ((taskId: TaskId) => KeptTaskAction | undefined) | undefined;
	private args: unknown;
	private result: RenderableToolResult | undefined;
	private executionStarted = false;
	private executionStartedAt: number | undefined;
	private argsComplete = false;
	private groupRole: ToolGroupRole = { kind: "standalone" };
	private groupHead: ToolGroupHead | undefined;
	/** Whether the last frame asked of the engine draws this call on its own, apart from its group. */
	private requestedApart = false;
	private isPartial = true;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: {
			showImages?: boolean;
			imageWidthCells?: number;
			outputPad?: number;
			rendererTaskId?: string;
			keptTaskAction?: (taskId: TaskId) => KeptTaskAction | undefined;
		},
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
	) {
		super(runtime, requestRender);
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.rendererTaskId = options.rendererTaskId;
		this.keptTaskAction = options.keptTaskAction;
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
	/** The first call of the group this call is folded into, which stands for it while both have one expansion. */
	setGroupHead(head: ToolGroupHead | undefined): void {
		this.groupHead = head;
	}
	/** Whether this call, folded into a group, is drawn and clicked on its own: see `drawsApartFromGroup`. */
	drawsApart(): boolean {
		return drawsApartFromGroup(this.groupRole, this.expanded, this.groupHead);
	}
	/** The place in its group the engine draws this call at: on its own while it is drawn apart from its group. */
	private drawnGroupRole(): ToolGroupRole {
		return this.requestedApart ? { kind: "standalone" } : this.groupRole;
	}
	override render(width: number): string[] {
		const apart = this.drawsApart();
		if (apart !== this.requestedApart) {
			this.requestedApart = apart;
			this.invalidate();
		}
		if (!this.expanded && this.groupRole.kind === "hidden" && !apart) return [];
		return super.render(width);
	}
	updateResult(result: RenderableToolResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		this.changed();
		// Once what settled it in this turn has run (such as the row becoming its group's head), so the engine is asked
		// for the row as the next paint would draw it, before that paint.
		if (!isPartial) queueMicrotask(() => this.sendLatestState());
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

	/**
	 * What the chat offers for the task this call's result left running, asked when the row is drawn; undefined when the
	 * chat does not decide that, or the result names no task.
	 */
	private resultTaskAction(): KeptTaskAction | "none" | undefined {
		if (this.keptTaskAction === undefined) return undefined;
		const taskId = keptTaskId({
			toolName: this.toolName,
			args: this.args,
			result: this.result,
			isPartial: this.isPartial,
		});
		return taskId === undefined ? undefined : (this.keptTaskAction(taskId as TaskId) ?? "none");
	}

	protected command(requestId: number, width: number): RemoteRenderCommand {
		const lines = savedReadLines(this.result?.content);
		const action = this.resultTaskAction();
		return {
			type: "engine_tool_render",
			...(lines === undefined ? {} : { savedReadLines: lines }),
			componentId: this.componentId,
			requestId,
			width,
			toolName: this.toolName,
			toolCallId: this.toolCallId,
			...(this.rendererTaskId === undefined ? {} : { rendererTaskId: this.rendererTaskId }),
			...(action === undefined ? {} : { keptTaskAction: action }),
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
			...(this.drawnGroupRole().kind === "standalone" ? {} : { groupRole: this.drawnGroupRole() }),
		};
	}

	protected frameIdentity(): string {
		return JSON.stringify([
			"tool",
			this.rendererTaskId,
			this.resultTaskAction() ?? null,
			this.toolName,
			this.toolCallId,
			this.expanded,
			toolGroupRoleKey(this.drawnGroupRole()),
		]);
	}
}

export class RemoteCustomMessageComponent extends RemoteRenderer {
	readonly ownsLeadingSpacer = true;
	private readonly message: CustomMessage<unknown>;
	private readonly reopenedStopName?: string;
	private contentDigest: string | undefined;
	private outputPad: number;
	constructor(
		message: CustomMessage<unknown>,
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
		outputPad = 1,
	) {
		super(runtime, requestRender);
		this.message = message;
		this.reopenedStopName = reopenedCompletionName(message, isProxy);
		this.outputPad = outputPad;
	}

	/**
	 * A message expands on a click, as Ctrl+O expands it: the engine draws its card, and a card with nothing more to
	 * show stays as it is.
	 */
	readonly expandsOnClick = true;
	/** Every row of the card: the engine draws it after the blank row it leads with. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.changed();
	}

	protected command(requestId: number, width: number): RemoteRenderCommand {
		const stopped = this.reopenedStopName;
		return {
			type: "engine_message_render",
			...(stopped === undefined ? {} : { reopenedStopName: stopped }),
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
		const stopped = this.reopenedStopName;
		return stopped === undefined
			? JSON.stringify(["message", this.message.customType, this.contentDigest, this.expanded])
			: JSON.stringify(["message", this.message.customType, this.contentDigest, this.expanded, stopped]);
	}
}
