import type { AgentToolResult } from "@bastani/atomic-agent-core";
import {
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { isBuiltinToolCallRenderer, isBuiltinToolResultRenderer } from "../../../core/tools/builtin-renderers.js";
import { allToolNames, createLoadedToolDefinition, type ToolName } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { CodeHighlighter, theme } from "../theme/theme.js";
import { watchAtomicWorkingClock } from "./atomic-working-status.ts";
import { keyHint, keyText } from "./keybinding-hints.js";
import { clickableKeyTextHint } from "./nav-keys.ts";
import { STATUS_MARKERS } from "./notice-line.ts";
import { declaresHistoryReplayable, disposeRenderer, runRendererCleanup } from "./renderer-disposal.js";
import {
	collapseToolBlockLines,
	componentNeedsWorkingClock,
	isToolBlock,
	ToolBlock,
	ToolBlockRecords,
	type ToolBlockStatus,
	type ToolGroupRole,
} from "./tool-block.ts";
import { builtinToolBlockPresentation, formatToolBlockElapsed } from "./tool-block-families.ts";
import { drawsApartFromGroup, type ToolGroupHead } from "./tool-group-tracker.ts";
import {
	blockRenderTime,
	blockRows,
	type RowRange,
	rowsFrom,
	setRendererClickTarget,
} from "./transcript-block-clicks.ts";

/** Extension tools without a renderer show this many output lines before collapsing. */
const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
	getTaskRecord?: (taskId: TaskId) => TaskRecord | undefined;
	getToolDefinition?: (toolName: string) => ToolRenderers | undefined;
}

type RenderableToolResult = Omit<AgentToolResult<unknown>, "details"> & {
	details?: unknown;
	isError: boolean;
	durationMs?: number;
};
type RenderableImageContent = Extract<RenderableToolResult["content"][number], { type: "image" }>;
/** Keep isolated-engine image components stable so pi-tui can reuse Kitty uploads. */
interface RenderedImageSpec {
	data: string;
	mimeType: string;
	protocol: "kitty" | "iterm2";
	widthCells: number;
}
const SUBAGENT_RESULT_ANIMATION_TIMER_KEY = "subagentResultAnimationTimer";
const SUBAGENT_RESULT_ANIMATION_CLEANUP_KEY = "subagentResultAnimationCleanup";

let statusMarkPrefix: RegExp | undefined;
/** A block's header row opens with its status mark, any of the shared marks, then a space. */
function blockStatusMarkPrefix(): RegExp {
	if (statusMarkPrefix === undefined) {
		const marks = [...new Set(Object.values(STATUS_MARKERS).map((marker) => marker.glyph))].join("");
		statusMarkPrefix = new RegExp(`^ *[${marks.replace(/[\\\]^-]/g, "\\$&")}] `, "u");
	}
	return statusMarkPrefix;
}

export class ToolExecutionComponent extends Container {
	get historyReplayable(): boolean {
		if (!this.toolDefinition) return true;
		return (
			(!this.toolDefinition.renderCall || declaresHistoryReplayable(this.callRendererComponent)) &&
			(!this.toolDefinition.renderResult || declaresHistoryReplayable(this.resultRendererComponent))
		);
	}
	get selectionTextMayChangeOnReplay(): boolean {
		return this.toolDefinition !== undefined;
	}
	readonly expandsOnClick = true;
	private contentContainer: Container;
	private readonly codeHighlighter = new CodeHighlighter();
	private readonly taskRecordReader: ToolExecutionOptions["getTaskRecord"];
	private readonly toolRendererReader: ToolExecutionOptions["getToolDefinition"];
	private stopWorkingClock: (() => void) | undefined;
	private disposed = false;
	private executionStartedAt: number | undefined;
	private elapsedMs: number | undefined;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: Record<string, unknown> = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: unknown;
	private expanded = false;
	private groupRole: ToolGroupRole = { kind: "standalone" };
	private groupHead: ToolGroupHead | undefined;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private builtInToolDefinition?: ToolDefinition<TSchema, unknown>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	/** `updateArgs()` ran since the last display update; the next render applies it. */
	private argsPending = false;
	private result?: RenderableToolResult;
	private renderedImageSpecs: RenderedImageSpec[] = [];
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = allToolNames.has(toolName as ToolName)
			? createLoadedToolDefinition(toolName as ToolName, cwd)
			: undefined;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.taskRecordReader = options.getTaskRecord;
		this.toolRendererReader = options.getToolDefinition;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		// The content starts after the spacer. Its title (row one) belongs to block disclosure, even for custom tools.
		if (toolDefinition) setRendererClickTarget(this, { container: this.contentContainer, top: 1, firstRow: 2 });

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<TSchema, unknown>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<TSchema, unknown>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				if (this.disposed) return;
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : (this.result?.durationMs ?? this.elapsedMs),
			outputPad: this.outputPad,
			getTaskRecord: this.taskRecordReader,
			getElapsedMs: () => this.currentElapsedMs(),
			getToolDefinition: this.toolRendererReader,
			keyText,
			keyHint,
		};
	}

	private createCallFallback(): Component {
		const label = this.toolDefinition?.label?.trim() || this.builtInToolDefinition?.label || this.toolName;
		const args =
			typeof this.args === "object" && this.args !== null && !Array.isArray(this.args)
				? Object.entries(this.args)
						.map(([key, value]) => {
							const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
							const text = terminalDisplayText(raw).replace(/[\r\n\t]/g, " ");
							return `${terminalDisplayText(key)}=${truncateToWidth(text, 64, "…")}`;
						})
						.join(" · ")
				: String(this.args ?? "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold(label))}${theme.fg("text", `(${terminalDisplayText(args).replace(/[\r\n\t]/g, " ")})`)}`,
			0,
			0,
		);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = terminalDisplayText(output).split("\n");
		const displayLines = collapseToolBlockLines(lines, FALLBACK_PREVIEW_LINES, this.expanded);
		return new Text(
			displayLines.map((line) => theme.fg(this.result?.isError ? "error" : "toolOutput", line)).join("\n"),
			0,
			0,
		);
	}

	/**
	 * Show new partial arguments. Applied at the next render, so a call streaming many argument deltas between two
	 * frames runs its renderer once per frame, not once per delta (earendil-works/pi#9265).
	 */
	updateArgs(args: unknown): void {
		if (this.disposed) return;
		this.args = args;
		this.argsPending = true;
		this.ui.requestRender();
	}

	// markExecutionStarted / setArgsComplete are idempotent: re-seeding an
	// already-started component must not schedule another render, or the
	// remote-renderer bridge (EngineRenderService) turns every repeated
	// engine_tool_render into a fresh invalidate → render ping-pong (TUI
	// flicker during streaming).
	markExecutionStarted(startedAt?: number): void {
		if (this.disposed || this.executionStarted) return;
		this.executionStarted = true;
		const now = blockRenderTime();
		this.executionStartedAt = startedAt !== undefined && Number.isFinite(startedAt) ? Math.min(startedAt, now) : now;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		if (this.disposed) return;
		if (this.argsComplete) return;
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: RenderableToolResult, isPartial = false): void {
		if (this.disposed) return;
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial)
			this.elapsedMs =
				result.durationMs ??
				(this.executionStartedAt === undefined
					? undefined
					: Math.max(0, blockRenderTime() - this.executionStartedAt));
		this.updateDisplay();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getGroupRole(): ToolGroupRole {
		return this.groupRole;
	}

	/** The first call of the group this call is folded into, which stands for it while both have one expansion. */
	setGroupHead(head: ToolGroupHead | undefined): void {
		if (this.disposed) return;
		this.groupHead = head;
	}

	/** Whether this call, folded into a group, is drawn and clicked on its own: see {@link drawsApartFromGroup}. */
	drawsApart(): boolean {
		return drawsApartFromGroup(this.groupRole, this.expanded, this.groupHead);
	}

	/** Every row of the block, below the blank row it leads with. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		if (this.disposed) return;
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	setGroupRole(role: ToolGroupRole): void {
		if (this.disposed) return;
		if (
			this.groupRole.kind === role.kind &&
			(role.kind !== "head" ||
				(this.groupRole.kind === "head" &&
					this.groupRole.clauses.length === role.clauses.length &&
					this.groupRole.clauses.every(
						(clause, index) =>
							clause.family === role.clauses[index]?.family && clause.count === role.clauses[index]?.count,
					)))
		)
			return;
		this.groupRole = role;
		this.ui.requestRender();
	}

	setOutputPad(outputPad: number): void {
		if (this.disposed) return;
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		if (this.disposed) return;
		if (this.showImages === show) return;
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		if (this.disposed) return;
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.updateDisplay();
	}

	override invalidate(): void {
		if (this.disposed) return;
		super.invalidate();
		this.updateDisplay();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopWorkingClock?.();
		this.stopWorkingClock = undefined;
		this.disposeRendererComponent(this.callRendererComponent);
		this.disposeRendererComponent(this.resultRendererComponent);
		this.callRendererComponent = undefined;
		this.resultRendererComponent = undefined;
		this.clearRendererStateTimer(SUBAGENT_RESULT_ANIMATION_TIMER_KEY, SUBAGENT_RESULT_ANIMATION_CLEANUP_KEY);
		this.clearRendererStateTimer("interval");
		this.rendererState = {};
		this.contentContainer.clear();
		this.imageComponents = [];
		this.imageSpacers = [];
		this.renderedImageSpecs = [];
		this.args = undefined;
		this.result = undefined;
		this.clear();
	}

	override render(width: number): string[] {
		return blockRows(this.renderRows(width));
	}

	private renderRows(width: number): string[] {
		if (this.disposed) return [];
		if (this.argsPending) this.updateDisplay();
		this.syncWorkingClock();
		if (this.hideComponent || width < 1) return [];
		if (!this.expanded && this.groupRole.kind === "hidden" && !this.drawsApart()) return [];
		if (!this.expanded && this.groupRole.kind === "head") return this.renderGroupSummary(width, this.groupRole);
		const content = this.contentContainer.render(width);
		if (content.length === 0 && this.imageComponents.length === 0) return [];
		const rows = content.length > 0 ? ["", ...content] : [];
		for (let index = 0; index < this.imageComponents.length; index += 1) {
			const spacer = this.imageSpacers[index];
			if (spacer) rows.push(...spacer.render(width));
			const image = this.imageComponents[index];
			if (image) rows.push(...image.render(width));
		}
		return rows;
	}

	private renderGroupSummary(width: number, role: Extract<ToolGroupRole, { kind: "head" }>): string[] {
		const wording = {
			read: ["read", "file", "files"],
			search: ["searched", "pattern", "patterns"],
			find: ["searched", "file pattern", "file patterns"],
			list: ["listed", "directory", "directories"],
			bash: ["ran", "shell command", "shell commands"],
		} as const;
		const clauses = role.clauses.map(({ family, count }, index) => {
			const [verb, singular, plural] = wording[family];
			const start = index === 0 ? `${verb.charAt(0).toUpperCase()}${verb.slice(1)}` : verb;
			return `${start} ${theme.bold(String(count))} ${count === 1 ? singular : plural}`;
		});
		const keys = keyText("app.tools.expand");
		const summary = clauses.join(", ");
		const title: Component = {
			invalidate() {},
			render(available) {
				if (available < 1) return [];
				const full = keys ? theme.fg("dim", `  (${clickableKeyTextHint(keys, " to expand")})`) : "";
				const compact = keys ? theme.fg("dim", ` (${clickableKeyTextHint(keys, "")})`) : "";
				const suffix = visibleWidth(full) < available ? full : visibleWidth(compact) < available ? compact : "";
				return [`${truncateToWidth(summary, available - visibleWidth(suffix), "…")}${suffix}`];
			},
		};
		return ["", ...new ToolBlock({ status: "success", title, outputPad: this.outputPad }).render(width)];
	}

	private blockStatus(): ToolBlockStatus {
		return this.isPartial ? "running" : this.result?.isError ? "failure" : "success";
	}

	private currentElapsedMs(): number | undefined {
		return (
			this.elapsedMs ??
			(this.executionStartedAt === undefined ? undefined : Math.max(0, blockRenderTime() - this.executionStartedAt))
		);
	}

	private blockMetadata(): readonly string[] | undefined {
		const duration = formatToolBlockElapsed(this.currentElapsedMs(), {
			isRunning: this.isPartial,
			subTenDecimal: this.toolName === "bash" || this.toolName === "fetch_content",
		});
		return duration ? [duration] : undefined;
	}

	private needsWorkingClock(): boolean {
		if (this.disposed) return false;
		if (this.isPartial) return true;
		if (this.result)
			return (
				componentNeedsWorkingClock(this.resultRendererComponent) ||
				(this.getRenderShell() === "self" && componentNeedsWorkingClock(this.callRendererComponent))
			);
		if (this.callRendererComponent && isToolBlock(this.callRendererComponent))
			return componentNeedsWorkingClock(this.callRendererComponent);
		return (
			componentNeedsWorkingClock(this.callRendererComponent) ||
			componentNeedsWorkingClock(this.resultRendererComponent)
		);
	}

	private syncWorkingClock(): void {
		if (this.needsWorkingClock()) {
			this.stopWorkingClock ??= watchAtomicWorkingClock(() => {
				if (this.disposed) return;
				if (!this.needsWorkingClock()) {
					this.stopWorkingClock?.();
					this.stopWorkingClock = undefined;
				}
				this.ui.requestRender();
			});
		} else {
			this.stopWorkingClock?.();
			this.stopWorkingClock = undefined;
		}
	}

	private canonicalCallTitle(call: Component): Component {
		return {
			invalidate: () => call.invalidate(),
			render: (width) => {
				const line = call.render(width).find((row) => stripTerminalSequences(row).trim().length > 0);
				if (line === undefined) return [terminalDisplayText(this.toolDefinition?.label ?? this.toolName)];
				const prefix = blockStatusMarkPrefix().exec(stripTerminalSequences(line))?.[0];
				return prefix
					? [sliceByColumn(line, visibleWidth(prefix), width)]
					: [terminalDisplayText(this.toolDefinition?.label ?? this.toolName)];
			},
		};
	}

	private updateDisplay(): void {
		if (this.disposed) return;
		this.argsPending = false;
		this.hideComponent = false;
		this.contentContainer.clear();
		const callRenderer = this.getCallRenderer();
		const resultRenderer = this.getResultRenderer();
		const presentation = builtinToolBlockPresentation({
			toolName: this.toolName,
			args: this.args,
			result: this.result,
			expanded: this.expanded,
			isPartial: this.isPartial,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			elapsedMs: this.currentElapsedMs(),
			highlighter: this.codeHighlighter,
			canManageTask: (taskId) => this.taskRecordReader?.(taskId as TaskId) !== undefined,
		});
		const canonicalCall = presentation !== undefined && (!callRenderer || isBuiltinToolCallRenderer(callRenderer));
		const canonicalResult =
			presentation !== undefined && (!resultRenderer || isBuiltinToolResultRenderer(resultRenderer));
		let call: Component;
		if (canonicalCall && presentation) {
			call = new Text(presentation.title, 0, 0);
			this.callRendererComponent = undefined;
		} else if (callRenderer) {
			try {
				call = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = call;
			} catch {
				this.callRendererComponent = undefined;
				call = new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
			}
		} else call = this.createCallFallback();
		let details: Component | undefined;
		if (canonicalResult && presentation) {
			details = presentation.details;
			this.resultRendererComponent = details;
		} else if (this.result) {
			if (resultRenderer) {
				try {
					details = resultRenderer(
						{ content: this.result.content, details: this.result.details, terminate: this.result.terminate },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.getRenderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = details;
				} catch {
					this.resultRendererComponent = undefined;
					details = new Text(theme.fg("warning", "Result renderer failed"), 0, 0);
				}
			} else details = this.createResultFallback();
		}
		if (
			this.expanded &&
			!callRenderer &&
			typeof this.args === "object" &&
			this.args !== null &&
			Object.keys(this.args).length > 0
		) {
			const argumentLines = Object.entries(this.args)
				.map(
					([key, value]) =>
						`${key}: ${typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "")}`,
				)
				.join("\n");
			const argumentsComponent = new Text(terminalDisplayText(argumentLines), 0, 0);
			details = new ToolBlockRecords([argumentsComponent, ...(details ? [details] : [])]);
		}
		const selfRendered =
			this.hasRendererDefinition() && this.getRenderShell() === "self" && !(canonicalCall && canonicalResult);
		const staticElapsed = formatToolBlockElapsed(this.currentElapsedMs(), { isRunning: true, subTenDecimal: false });
		const staticMeta = presentation?.meta?.filter((part) => part !== staticElapsed) ?? [];
		const connectedDetails =
			details &&
			!canonicalResult &&
			!isToolBlock(details) &&
			!("toolBlockKind" in details && details.toolBlockKind === "records")
				? new ToolBlockRecords([details], { preserveConnectors: true })
				: details;
		if (details && isToolBlock(details)) this.contentContainer.addChild(details);
		else if (selfRendered) {
			this.contentContainer.addChild(call);
			if (details) this.contentContainer.addChild(details);
		} else if (isToolBlock(call)) {
			if (this.result === undefined) this.contentContainer.addChild(call);
			else {
				const title = this.canonicalCallTitle(call);
				this.contentContainer.addChild({
					invalidate: () => title.invalidate(),
					render: (width) =>
						new ToolBlock({
							status: this.blockStatus(),
							title,
							details: connectedDetails,
							outputPad: this.outputPad,
						}).render(width),
				});
			}
		} else {
			this.contentContainer.addChild({
				invalidate() {
					call.invalidate();
					details?.invalidate();
				},
				render: (width) => {
					const meta =
						canonicalResult && presentation
							? this.isPartial && presentation.status === "running"
								? [...(this.blockMetadata() ?? []), ...staticMeta]
								: presentation.meta
							: this.blockMetadata();
					return new ToolBlock({
						status: canonicalResult ? (presentation?.status ?? this.blockStatus()) : this.blockStatus(),
						title: canonicalCall && presentation ? presentation.title : call,
						args: canonicalCall ? presentation?.args : undefined,
						meta,
						details: connectedDetails,
						outputPad: this.outputPad,
					}).render(width);
				},
			});
		}
		this.syncImageComponents();
		this.syncWorkingClock();
	}

	private syncImageComponents(): void {
		const capabilities = getCapabilities();
		const nextSpecs: RenderedImageSpec[] = [];
		if (this.result && this.showImages && capabilities.images) {
			const imageBlocks = this.result.content.filter((c): c is RenderableImageContent => c.type === "image");
			for (const image of imageBlocks) {
				if (!image.data || !image.mimeType) continue;
				nextSpecs.push({
					data: image.data,
					mimeType: image.mimeType,
					protocol: capabilities.images,
					widthCells: this.imageWidthCells,
				});
				if (image.mimeType !== "image/png") {
					ensurePngTranscoder(() => {
						if (this.disposed) return;
						this.invalidate();
						this.ui.requestRender();
					});
				}
			}
		}

		const unchanged =
			nextSpecs.length === this.renderedImageSpecs.length &&
			nextSpecs.every((spec, index) => {
				const previous = this.renderedImageSpecs[index];
				return (
					previous?.data === spec.data &&
					previous.mimeType === spec.mimeType &&
					previous.protocol === spec.protocol &&
					previous.widthCells === spec.widthCells
				);
			});
		if (unchanged) return;

		for (const image of this.imageComponents) this.removeChild(image);
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) this.removeChild(spacer);
		this.imageSpacers = [];
		this.renderedImageSpecs = nextSpecs;

		for (const spec of nextSpecs) {
			const spacer = new Spacer(1);
			this.addChild(spacer);
			this.imageSpacers.push(spacer);
			const image = new Image(
				spec.data,
				spec.mimeType,
				{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
				{ maxWidthCells: spec.widthCells },
			);
			this.imageComponents.push(image);
			this.addChild(image);
		}
	}
	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private disposeRendererComponent(component: Component | undefined): void {
		disposeRenderer(component);
	}

	private clearRendererStateTimer(timerKey: string, cleanupKey?: string): void {
		const cleanup = cleanupKey ? this.rendererState[cleanupKey] : undefined;
		if (typeof cleanup === "function") runRendererCleanup(() => cleanup());
		const timer = this.rendererState[timerKey];
		if (timer === undefined) return;
		clearInterval(timer as ReturnType<typeof setInterval>);
		this.rendererState[timerKey] = undefined;
		if (cleanupKey) this.rendererState[cleanupKey] = undefined;
	}
}
