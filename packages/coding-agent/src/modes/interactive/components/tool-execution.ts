import type { AgentToolResult } from "@bastani/atomic-agent-core";
import {
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@bastani/atomic-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { isBuiltinToolCallRenderer, isBuiltinToolResultRenderer } from "../../../core/tools/builtin-renderers.js";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { CodeHighlighter, theme } from "../theme/theme.js";
import { watchAtomicWorkingClock } from "./atomic-working-status.ts";
import { keyHint, keyHintIfBound, keyText } from "./keybinding-hints.js";
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
type DisposableRendererComponent = Component & { dispose?: () => void };
/** Keep isolated-engine image components stable so pi-tui can reuse Kitty uploads. */
interface RenderedImageSpec {
	data: string;
	mimeType: string;
	protocol: "kitty" | "iterm2";
	widthCells: number;
}
const SUBAGENT_RESULT_ANIMATION_TIMER_KEY = "subagentResultAnimationTimer";
const SUBAGENT_RESULT_ANIMATION_CLEANUP_KEY = "subagentResultAnimationCleanup";

export class ToolExecutionComponent extends Container {
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
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
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
			typeof this.args === "object" && this.args !== null
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
		this.args = args;
		this.argsPending = true;
		this.ui.requestRender();
	}

	// markExecutionStarted / setArgsComplete are idempotent: re-seeding an
	// already-started component must not schedule another render, or the
	// remote-renderer bridge (EngineRenderService) turns every repeated
	// engine_tool_render into a fresh invalidate → render ping-pong (TUI
	// flicker while a workflow stage streams).
	markExecutionStarted(startedAt?: number): void {
		if (this.disposed || this.executionStarted) return;
		this.executionStarted = true;
		const now = Date.now();
		this.executionStartedAt = startedAt !== undefined && Number.isFinite(startedAt) ? Math.min(startedAt, now) : now;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		if (this.argsComplete) return;
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: RenderableToolResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		if (!isPartial)
			this.elapsedMs =
				result.durationMs ??
				(this.executionStartedAt === undefined ? undefined : Math.max(0, Date.now() - this.executionStartedAt));
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	setGroupRole(role: ToolGroupRole): void {
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
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.updateDisplay();
	}

	override invalidate(): void {
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
	}

	override render(width: number): string[] {
		if (this.argsPending) this.updateDisplay();
		this.syncWorkingClock();
		if (this.hideComponent || width < 1 || (!this.expanded && this.groupRole.kind === "hidden")) return [];
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
		const hint = keyHintIfBound("app.tools.expand", "to expand");
		const title = `${clauses.join(", ")}${hint ? `  (${hint})` : ""}`;
		return [
			"",
			...new ToolBlock({ status: "success", title: new Text(title, 0, 0), outputPad: this.outputPad }).render(width),
		];
	}

	private blockStatus(): ToolBlockStatus {
		return this.isPartial ? "running" : this.result?.isError ? "failure" : "success";
	}

	private currentElapsedMs(): number | undefined {
		return (
			this.elapsedMs ??
			(this.executionStartedAt === undefined ? undefined : Math.max(0, Date.now() - this.executionStartedAt))
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
		if (this.resultRendererComponent && isToolBlock(this.resultRendererComponent))
			return componentNeedsWorkingClock(this.resultRendererComponent);
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

	private updateDisplay(): void {
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
		if (details && isToolBlock(details)) this.contentContainer.addChild(details);
		else if (isToolBlock(call)) this.contentContainer.addChild(call);
		else if (selfRendered) {
			this.contentContainer.addChild(call);
			if (details) this.contentContainer.addChild(details);
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
						details,
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
		(component as DisposableRendererComponent | undefined)?.dispose?.();
	}

	private clearRendererStateTimer(timerKey: string, cleanupKey?: string): void {
		const cleanup = cleanupKey ? this.rendererState[cleanupKey] : undefined;
		if (typeof cleanup === "function") {
			cleanup();
			return;
		}
		const timer = this.rendererState[timerKey];
		if (timer === undefined) return;
		clearInterval(timer as ReturnType<typeof setInterval>);
		this.rendererState[timerKey] = undefined;
		if (cleanupKey) this.rendererState[cleanupKey] = undefined;
	}
}
