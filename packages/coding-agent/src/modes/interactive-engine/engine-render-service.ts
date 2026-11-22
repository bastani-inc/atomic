import type { Terminal, TUI } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import { runSynchronousCallback } from "../../core/callback-activity.ts";
import type { RendererChange, ResolvedToolRenderers } from "../../core/extensions/runner.ts";
import type { MessageRenderer, ToolRendererResolver, ToolRenderers } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { bindSavedReadLines } from "../../core/storage/session/saved-read-summary.js";
import type { TaskId } from "../../core/tasks/contracts.js";
import type { OwnerTaskStore } from "../../core/tasks/owner-store.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { taskTranscriptSource } from "../../core/tasks/supervisor.js";
import { readTaskCompletionHistory } from "../../core/tasks/task-completion-history.js";
import { isBuiltinToolCallRenderer, isBuiltinToolResultRenderer } from "../../core/tools/builtin-renderers.js";
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
import { CustomMessageComponent } from "../interactive/components/custom-message.ts";
import type { KeptTaskAction } from "../interactive/components/kept-task.ts";
import { disposeRenderer, runRendererCleanup } from "../interactive/components/renderer-disposal.js";
import { ToolBlock } from "../interactive/components/tool-block.ts";
import { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import { RETAINED_TOOL_RENDERERS, retainedToolRenderer } from "../interactive/components/tool-renderer-scope.js";
import { sameRows, withBlockRenderTime } from "../interactive/components/transcript-block-clicks.ts";
import { BackgroundRenderLane, BackgroundRenderTui } from "./background-render-lane.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
} from "./protocol.ts";

type ToolRenderCommand = Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>;
type MessageRenderCommand = Extract<InteractiveEngineCommand, { type: "engine_message_render" }>;

/** What the host's chat offers for the task `command`'s result left running, which the host decided. */
function keptTaskActionOf(command: ToolRenderCommand): () => KeptTaskAction | undefined {
	const action = command.keptTaskAction;
	return () => (action === "none" ? undefined : action);
}

/**
 * Cached per-componentId render state. Records are REUSED across render
 * requests: recreating (and re-seeding) the component on every request made
 * the seeding setters call `ui.requestRender()` each time, whose eventual
 * terminal write emitted `engine_custom_invalidate` back to the host, which
 * re-sent the render request — a self-sustaining host⇄engine render
 * ping-pong that presented as full-screen TUI flicker (a transcript update while a
 * tool call streams). Reuse plus idempotent seeding setters lets the
 * loop converge after at most one round trip while still forwarding
 * legitimate async invalidations (e.g. image conversion). A record is rebuilt
 * once the session's extension runner changes, so rows rendered before
 * deferred resources loaded pick up the extensions' renderers.
 */
interface ResolvedToolSource {
	readonly source: ToolRendererResolver | "base";
	readonly baseId: string | ToolRenderers;
	readonly hasRenderers: boolean;
	readonly renderShell: ToolRenderers["renderShell"] | undefined;
}

function baseToolIdentity(
	session: AgentSession,
	toolName: string,
	base: ToolRenderers | undefined,
): string | ToolRenderers {
	if (base === undefined) return "none";
	const entry = (
		session as unknown as { _toolDefinitions?: Map<string, { sourceInfo?: { source?: string } }> }
	)._toolDefinitions?.get(toolName);
	if (entry?.sourceInfo?.source === "builtin") return `builtin:${toolName}`;
	if (
		(base.renderCall !== undefined || base.renderResult !== undefined) &&
		(base.renderCall === undefined || isBuiltinToolCallRenderer(base.renderCall)) &&
		(base.renderResult === undefined || isBuiltinToolResultRenderer(base.renderResult)) &&
		(base.renderShell === undefined || base.renderShell === "default")
	) {
		return `builtin:${toolName}`;
	}
	return base;
}

function toolSourceFrom(session: AgentSession, toolName: string, resolved: ResolvedToolRenderers): ResolvedToolSource {
	return {
		source: resolved.source,
		baseId: baseToolIdentity(session, toolName, resolved.base),
		hasRenderers: resolved.renderers !== undefined,
		renderShell: resolved.renderers?.renderShell,
	};
}

function sameToolSource(a: ResolvedToolSource | undefined, b: ResolvedToolSource): boolean {
	if (!a) return false;
	return (
		a.source === b.source &&
		a.baseId === b.baseId &&
		a.hasRenderers === b.hasRenderers &&
		a.renderShell === b.renderShell
	);
}

type RenderRecord = {
	runner: AgentSession["extensionRunner"];
	terminal: RenderTerminal;
	tui: TUI;
} & (
	| {
			kind: "message";
			customType: string;
			resolvedRenderer: MessageRenderer | undefined;
			component: CustomMessageComponent;
	  }
	| {
			kind: "tool";
			toolName: string;
			resolvedToolSource?: ResolvedToolSource;
			component: ToolExecutionComponent;
			toolOwner: object;
			rendererTaskId?: string;
			keptTaskAction?: "tasks" | "ownTasks" | "openWaited" | "none";
			stopOwnerWatch?: () => void;
	  }
);

interface ToolRendererScope {
	identity: object;
	session: object;
	cwd: string;
	resolve(name: string): ToolRenderers | undefined;
	watchedTask?: { store: OwnerTaskStore; taskId: TaskId; currentIdentity(): object | undefined };
}

class RenderTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private readonly requestRender: () => void;
	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {
		this.requestRender();
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

/**
 * How many disposed row ids the engine remembers. A render request can reach the engine after its row's disposal:
 * renders are coalesced behind the host's ordered writes, and a render waits on the background lane after its line
 * is read.
 * Without the tombstone that late render would rebuild the record the disposal released, for the rest of the session.
 * Row ids are never reused, and a render this many disposals late does not happen in practice.
 */
export const DISPOSED_RENDER_TOMBSTONE_LIMIT = 10_000;

export class EngineRenderService {
	private readonly records = new Map<string, RenderRecord>();
	private readonly messageRecordsByType = new Map<string, Set<string>>();
	private readonly toolRecordsByName = new Map<string, Set<string>>();
	private readonly disposedIds = new Set<string>();
	private session: AgentSession | undefined;
	private watchedRunner: AgentSession["extensionRunner"] | undefined;
	private stopRendererWatch: (() => void) | undefined;
	private readonly write: (line: string) => void;
	/** Row renders and repaint checks wait here, behind keyboard input and custom UI frames. */
	private readonly backgroundRenders = new BackgroundRenderLane();

	constructor(write: (line: string) => void) {
		this.write = write;
	}

	bindSession(session: AgentSession): void {
		this.dispose();
		this.session = session;
		this.ensureRendererWatch(session.extensionRunner);
	}

	private ensureRendererWatch(runner: AgentSession["extensionRunner"] | undefined): void {
		if (runner === this.watchedRunner) return;
		this.stopRendererWatch?.();
		this.stopRendererWatch = undefined;
		this.watchedRunner = runner;
		this.stopRendererWatch = runner?.onRenderersChanged?.(
			(change) => {
				this.invalidateStaleRendererRecords(change);
			},
			() => {
				if (this.watchedRunner === runner) {
					this.watchedRunner = undefined;
					this.stopRendererWatch = undefined;
				}
			},
		);
	}

	private invalidateStaleRendererRecords(change: RendererChange): void {
		const session = this.session;
		const currentRunner = session?.extensionRunner;
		if (!session || !currentRunner) return;

		for (const customType of change.messageTypes) {
			const ids = this.messageRecordsByType.get(customType);
			if (!ids || ids.size === 0) continue;
			const nextRenderer = currentRunner.getMessageRenderer(customType);
			for (const componentId of [...ids]) {
				const record = this.records.get(componentId);
				if (record?.kind !== "message" || record.runner !== currentRunner) continue;
				if (record.resolvedRenderer === nextRenderer) continue;
				this.disposeRecord(componentId);
				this.send({ type: "engine_custom_invalidate", componentId });
			}
		}

		const candidateToolNames = change.hasToolResolvers ? [...this.toolRecordsByName.keys()] : [...change.toolNames];
		for (const toolName of candidateToolNames) {
			const ids = this.toolRecordsByName.get(toolName);
			if (!ids || ids.size === 0) continue;
			let hasRootRecord = false;
			for (const componentId of ids) {
				const record = this.records.get(componentId);
				if (record?.kind === "tool" && record.toolOwner === currentRunner) {
					hasRootRecord = true;
					break;
				}
			}
			if (!hasRootRecord) continue;
			const nextSource = toolSourceFrom(
				session,
				toolName,
				currentRunner.resolveToolRenderersWithSource(toolName, () => session.getToolDefinition(toolName)),
			);
			for (const componentId of [...ids]) {
				const record = this.records.get(componentId);
				if (
					record?.kind !== "tool" ||
					record.toolOwner !== currentRunner ||
					record.resolvedToolSource === undefined
				) {
					continue;
				}
				if (sameToolSource(record.resolvedToolSource, nextSource)) continue;
				this.disposeRecord(componentId);
				this.send({ type: "engine_custom_invalidate", componentId });
			}
		}
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command?.type.startsWith("engine_") || command.type.startsWith("engine_custom_")) return false;
		if (command.type === "engine_render_dispose") {
			this.disposeRecord(command.componentId);
			this.disposedIds.add(command.componentId);
			if (this.disposedIds.size > DISPOSED_RENDER_TOMBSTONE_LIMIT) {
				const oldest = this.disposedIds.values().next().value;
				if (oldest !== undefined) this.disposedIds.delete(oldest);
			}
			return true;
		}
		if (command.type !== "engine_tool_render" && command.type !== "engine_message_render") return false;
		const name =
			command.type === "engine_tool_render"
				? `tool:${command.toolName}`
				: `message:${command.message.customType ?? "custom"}`;
		this.backgroundRenders.schedule(`frame:${command.componentId}`, () => this.renderFrame(command, name));
		return true;
	}

	/** Runs on the background lane, where a newer request for the same row replaces this one until it starts. */
	private renderFrame(command: ToolRenderCommand | MessageRenderCommand, name: string): void {
		// The row may have been disposed before this render arrived, or while it waited for its turn: rendering it
		// now would rebuild the record its disposal released.
		if (this.disposedIds.has(command.componentId)) return;
		try {
			const frame = runSynchronousCallback({ kind: "renderer", name }, () => {
				const draw = () =>
					command.type === "engine_tool_render" ? this.renderTool(command) : this.renderMessage(command);
				if (!command.compareExpansion) return { lines: draw() };
				return withBlockRenderTime(() => {
					const lines = draw();
					const component = this.records.get(command.componentId)?.component;
					if (!component) return { lines, expansionChangesRows: false };
					try {
						component.setExpanded(!command.expanded);
						return { lines, expansionChangesRows: !sameRows(lines, component.render(command.width)) };
					} finally {
						component.setExpanded(command.expanded);
					}
				});
			});
			this.send({
				type: "engine_custom_frame",
				componentId: command.componentId,
				requestId: command.requestId,
				...(command.inspectHistoryReplay && this.records.get(command.componentId)?.component.historyReplayable
					? { historyReplayable: true as const }
					: {}),
				...frame,
			});
		} catch {
			this.send({
				type: "engine_custom_frame",
				componentId: command.componentId,
				requestId: command.requestId,
				...(command.compareExpansion ? { expansionChangesRows: false } : {}),
				lines: new ToolBlock({
					status: "failure",
					title: command.type === "engine_tool_render" ? "Tool renderer failed" : "Message renderer failed",
					outputPad: command.outputPad,
				}).render(command.width),
			});
		}
	}

	dispose(): void {
		this.stopRendererWatch?.();
		this.stopRendererWatch = undefined;
		this.watchedRunner = undefined;
		for (const id of [...this.records.keys()]) this.disposeRecord(id);
	}

	private boundSession(): AgentSession {
		const session = this.session;
		if (!session) throw new Error("Renderer session is not bound");
		return session;
	}

	private createTerminal(componentId: string): RenderTerminal {
		return new RenderTerminal(() => this.send({ type: "engine_custom_invalidate", componentId }));
	}

	/** A row's headless screen; its repaint checks wait on the background lane. */
	private createScreen(terminal: RenderTerminal, componentId: string): TUI {
		return new BackgroundRenderTui(terminal, this.backgroundRenders, `check:${componentId}`);
	}

	private toolRendererScope(command: ToolRenderCommand): ToolRendererScope | undefined {
		const root = this.boundSession();
		const rootScope: ToolRendererScope = {
			identity: root.extensionRunner,
			session: root,
			cwd: root.sessionManager.getCwd(),
			resolve: (name) => root.extensionRunner.resolveToolRenderers(name, () => root.getToolDefinition(name)),
		};
		if (command.rendererTaskId === undefined) return rootScope;
		const store = getOwnerTaskStore(root);
		const taskId = command.rendererTaskId as TaskId;
		const lease = store?.resolveTask(taskId);
		if (!store || !lease?.ok) return undefined;
		const transcript = taskTranscriptSource(lease.value);
		if (!transcript.ok) return undefined;
		const source = transcript.value.session;
		const session = source.chatSession;
		if (!session?.getToolDefinition && !session?.extensionRunner?.resolveToolRenderers) {
			return RETAINED_TOOL_RENDERERS.has(command.toolName)
				? {
						...rootScope,
						cwd: source.commands?.().cwd ?? rootScope.cwd,
						resolve: (name) => retainedToolRenderer(name, rootScope.resolve),
					}
				: undefined;
		}
		return {
			identity: session.extensionRunner ?? session,
			session,
			cwd: source.commands?.().cwd ?? rootScope.cwd,
			resolve: (name) =>
				session.extensionRunner?.resolveToolRenderers?.(name, () => session.getToolDefinition?.(name)) ??
				session.getToolDefinition?.(name),
			watchedTask: {
				store,
				taskId,
				currentIdentity: () => {
					const current = taskTranscriptSource(lease.value);
					const live = current.ok ? current.value.session.chatSession : undefined;
					return live?.extensionRunner ?? live;
				},
			},
		};
	}

	private renderTool(command: ToolRenderCommand): string[] {
		const scope = this.toolRendererScope(command);
		if (!scope) {
			this.disposeRecord(command.componentId);
			return [
				"",
				...new ToolBlock({
					status: "warning",
					title: "Tool renderer unavailable",
					outputPad: command.outputPad,
				}).render(command.width),
			];
		}
		let record = this.records.get(command.componentId);
		const currentRunner = this.session?.extensionRunner;
		this.ensureRendererWatch(currentRunner);
		if (
			record?.kind !== "tool" ||
			record.runner !== currentRunner ||
			record.toolOwner !== scope.identity ||
			record.rendererTaskId !== command.rendererTaskId ||
			record.keptTaskAction !== command.keptTaskAction
		) {
			const session = this.boundSession();
			this.disposeRecord(command.componentId);
			const terminal = this.createTerminal(command.componentId);
			terminal.columns = Math.max(1, command.width);
			const tui = this.createScreen(terminal, command.componentId);
			ensurePngTranscoder(() => {
				tui.invalidate();
				tui.requestRender();
			});
			const rootOwned = scope.identity === session.extensionRunner;
			const rootResolved =
				rootOwned && typeof session.extensionRunner.resolveToolRenderersWithSource === "function"
					? session.extensionRunner.resolveToolRenderersWithSource(command.toolName, () =>
							session.getToolDefinition(command.toolName),
						)
					: undefined;
			const resolvedRenderers = rootResolved ? rootResolved.renderers : scope.resolve(command.toolName);
			const component = new ToolExecutionComponent(
				command.toolName,
				command.toolCallId,
				command.args,
				{
					showImages: command.showImages,
					imageWidthCells: command.imageWidthCells,
					outputPad: command.outputPad,
					getTaskRecord: (taskId) => getOwnerTaskStore(scope.session)?.getTask(taskId),
					// The host's chat knows what it offers for the task this call's result left running, and says so.
					...(command.keptTaskAction === undefined ? {} : { keptTaskAction: keptTaskActionOf(command) }),
					getToolDefinition: scope.resolve,
				},
				resolvedRenderers,
				tui,
				scope.cwd,
			);
			tui.addChild(component);
			record = {
				kind: "tool",
				toolName: command.toolName,
				resolvedToolSource: rootResolved ? toolSourceFrom(session, command.toolName, rootResolved) : undefined,
				component,
				terminal,
				tui,
				runner: session.extensionRunner,
				toolOwner: scope.identity,
				rendererTaskId: command.rendererTaskId,
				keptTaskAction: command.keptTaskAction,
			};
			this.records.set(command.componentId, record);
			let toolIds = this.toolRecordsByName.get(command.toolName);
			if (!toolIds) {
				toolIds = new Set();
				this.toolRecordsByName.set(command.toolName, toolIds);
			}
			toolIds.add(command.componentId);
			if (scope.watchedTask) {
				const { store, taskId, currentIdentity } = scope.watchedTask;
				const ownerIdentity = scope.identity;
				record.stopOwnerWatch = store.subscribe(() => {
					const task = store.getTask(taskId);
					if (task && task.execution.kind !== "settled" && currentIdentity() === ownerIdentity) return;
					this.disposeRecord(command.componentId);
					this.send({ type: "engine_custom_invalidate", componentId: command.componentId });
				});
			}
		} else {
			record.terminal.columns = Math.max(1, command.width);
			record.component.updateArgs(command.args);
			record.component.setShowImages(command.showImages);
			record.component.setImageWidthCells(command.imageWidthCells);
			record.component.setOutputPad(command.outputPad ?? 1);
		}
		const tool = record.component;
		if (command.executionStarted) tool.markExecutionStarted(command.executionStartedAt);
		if (command.argsComplete) tool.setArgsComplete();
		tool.setExpanded(command.expanded);
		tool.setGroupRole(command.groupRole ?? { kind: "standalone" });
		if (command.result) {
			if (command.savedReadLines !== undefined && Array.isArray(command.result.content))
				bindSavedReadLines(command.result.content, command.savedReadLines);
			tool.updateResult(
				command.result as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0],
				command.isPartial,
			);
		}
		return tool.render(command.width);
	}

	private renderMessage(command: MessageRenderCommand): string[] {
		const session = this.boundSession();
		const currentRunner = session.extensionRunner;
		this.ensureRendererWatch(currentRunner);
		const message = command.message as unknown as CustomMessage<object>;
		const resolvedRenderer = currentRunner.getMessageRenderer(message.customType);
		let record = this.records.get(command.componentId);
		if (
			record?.kind !== "message" ||
			record.runner !== currentRunner ||
			record.resolvedRenderer !== resolvedRenderer
		) {
			this.disposeRecord(command.componentId);
			const terminal = this.createTerminal(command.componentId);
			terminal.columns = Math.max(1, command.width);
			const tui = this.createScreen(terminal, command.componentId);
			ensurePngTranscoder(() => {
				tui.invalidate();
				tui.requestRender();
			});
			const component = new CustomMessageComponent(
				message,
				resolvedRenderer,
				undefined,
				command.outputPad,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					reopenedStopName: command.reopenedStopName,
					hasTranscript: (taskId) => {
						const lease = getOwnerTaskStore(session)?.resolveTask(taskId);
						return lease?.ok ? taskTranscriptSource(lease.value).ok : false;
					},
					loadTranscript: async (taskId, options) => {
						const lease = getOwnerTaskStore(session)?.resolveTask(taskId);
						return lease?.ok ? readTaskCompletionHistory(lease.value, options?.signal) : undefined;
					},
					getToolDefinition: (name) =>
						session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name)),
					cwd: session.sessionManager.getCwd(),
					// A card read its transcript for an expansion. The last check may have seen the same rows on an
					// earlier expansion, before a fold the host drew without it: repaint without comparing to it.
					requestRender: () => tui.requestRender(true),
				},
			);
			tui.addChild(component);
			record = {
				kind: "message",
				customType: message.customType,
				resolvedRenderer,
				component,
				terminal,
				tui,
				runner: currentRunner,
			};
			this.records.set(command.componentId, record);
			let msgIds = this.messageRecordsByType.get(message.customType);
			if (!msgIds) {
				msgIds = new Set();
				this.messageRecordsByType.set(message.customType, msgIds);
			}
			msgIds.add(command.componentId);
		} else {
			record.terminal.columns = Math.max(1, command.width);
		}
		record.component.setExpanded(command.expanded);
		record.component.setOutputPad(command.outputPad);
		return record.component.render(command.width);
	}

	private disposeRecord(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		this.records.delete(id);
		if (record.kind === "message") {
			const msgIds = this.messageRecordsByType.get(record.customType);
			if (msgIds) {
				msgIds.delete(id);
				if (msgIds.size === 0) this.messageRecordsByType.delete(record.customType);
			}
		} else {
			const toolIds = this.toolRecordsByName.get(record.toolName);
			if (toolIds) {
				toolIds.delete(id);
				if (toolIds.size === 0) this.toolRecordsByName.delete(record.toolName);
			}
			runRendererCleanup(record.stopOwnerWatch);
		}
		disposeRenderer(record.component);
		runRendererCleanup(() => record.tui.stop());
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
