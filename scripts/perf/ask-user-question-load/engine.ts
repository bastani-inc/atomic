#!/usr/bin/env bun
/**
 * Engine half of the ask_user_question load benchmark. `benchmark.ts` spawns it once per measured run.
 *
 * It runs the production engine-side UI code behind the production stdin path: the JSONL reader, the RPC input
 * scheduler, `EngineCustomUiService` and `EngineRenderService`, with the engine's callback-activity reporter
 * installed. The questionnaire is opened through `presentQuestionnaire`, as the tool does.
 *
 * Background load is synthetic and set by the JSON argument:
 * - `widgets` workflow-style widgets, each asking to repaint `widgetHz` times a second and costing `widgetCostMs`
 *   of CPU per render;
 * - an extension-level `ui.requestRender()` broadcast `broadcastHz` times a second.
 * Streaming subagent tool cards are driven by the host side, which sends their render requests.
 *
 * Besides the engine protocol, it reads `bench_*` lines from the driver and answers `bench_counters` with render
 * counts gathered by wrapping component prototypes, so the same harness measures any revision of the dialog.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, setKeybindings } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.js";
import { setCallbackActivityReporter } from "../../../packages/coding-agent/src/core/callback-activity.js";
import type { ExtensionUIContext } from "../../../packages/coding-agent/src/core/extensions/ui-types.js";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.js";
import { writeRawStdout, writeRawStdoutControl } from "../../../packages/coding-agent/src/core/output-guard.js";
import { presentQuestionnaire } from "../../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { TabBar } from "../../../packages/coding-agent/src/core/tools/ask-user-question/view/components/tab-bar.js";
import { WrappingSelect } from "../../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.js";
import { DialogView } from "../../../packages/coding-agent/src/core/tools/ask-user-question/view/dialog-builder.js";
import { initTheme, theme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { EngineRenderService } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-render-service.js";
import { serializeInteractiveEngineMessage } from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { attachJsonlLineReader } from "../../../packages/coding-agent/src/modes/rpc/jsonl.js";
import { createRpcInputScheduler } from "../../../packages/coding-agent/src/modes/rpc/rpc-input-scheduler.js";
import { benchmarkQuestionnaire } from "./fixture.js";

export interface EngineLoad {
	readonly widgets: number;
	readonly widgetHz: number;
	readonly widgetCostMs: number;
	readonly broadcastHz: number;
}

/** Render work the engine did, by kind. `dialogFrames` counts frames actually built, not cached frames returned. */
export interface EngineCounters {
	dialogRenderCalls: number;
	dialogFrames: number;
	optionListRenders: number;
	markdownRenders: number;
	markdownMisses: number;
	widgetRenders: number;
	broadcasts: number;
}

export type BenchControl =
	| { type: "bench_open_dialog" }
	| { type: "bench_start_load" }
	| { type: "bench_reset_counters" }
	| { type: "bench_counters" };

const counters: EngineCounters = {
	dialogRenderCalls: 0,
	dialogFrames: 0,
	optionListRenders: 0,
	markdownRenders: 0,
	markdownMisses: 0,
	widgetRenders: 0,
	broadcasts: 0,
};

function countCalls<T extends object>(prototype: T, method: keyof T & string, onCall: (self: T) => void): void {
	const original = Reflect.get(prototype, method) as (this: T, ...args: unknown[]) => unknown;
	Reflect.set(prototype, method, function (this: T, ...args: unknown[]) {
		onCall(this);
		return original.apply(this, args);
	});
}

countCalls(DialogView.prototype, "render", () => counters.dialogRenderCalls++);
countCalls(TabBar.prototype, "render", () => counters.dialogFrames++);
countCalls(WrappingSelect.prototype, "render", () => counters.optionListRenders++);
/** pi-tui keeps one wrapped result per Markdown; a render that finds it for the same text and width is a hit. */
function isMarkdownCacheHit(markdown: Markdown, width: number): boolean {
	const cachedLines: string[] | undefined = Reflect.get(markdown, "cachedLines");
	const cachedText: string | undefined = Reflect.get(markdown, "cachedText");
	const cachedWidth: number | undefined = Reflect.get(markdown, "cachedWidth");
	const text: string = Reflect.get(markdown, "text");
	return cachedLines !== undefined && cachedText === text && cachedWidth === width;
}

const markdownRender = Markdown.prototype.render;
Markdown.prototype.render = function (this: Markdown, width: number): string[] {
	counters.markdownRenders++;
	if (!isMarkdownCacheHit(this, width)) counters.markdownMisses++;
	return markdownRender.call(this, width);
};

function busyFor(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {}
}

function widgetLines(index: number, tick: number, width: number): string[] {
	return Array.from({ length: 6 }, (_, row) =>
		theme
			.fg("muted", `worker ${index} stage ${row} tick ${tick} — streaming status for this pooled child`)
			.slice(0, width),
	);
}

const load = JSON.parse(process.argv[2] ?? "{}") as EngineLoad;
const agentDir = mkdtempSync(join(tmpdir(), "aq-load-engine-"));
initTheme("dark");
const keybindings = KeybindingsManager.create(agentDir);
setKeybindings(keybindings);

const send = (message: Parameters<typeof serializeInteractiveEngineMessage>[0]) =>
	writeRawStdout(serializeInteractiveEngineMessage(message));
setCallbackActivityReporter({
	started: (activity) =>
		writeRawStdoutControl(serializeInteractiveEngineMessage({ type: "engine_activity_started", activity })),
	finished: (activityId) => send({ type: "engine_activity_finished", activityId }),
});

const customUi = new EngineCustomUiService(writeRawStdout, keybindings);
const renderService = new EngineRenderService(writeRawStdout);
renderService.bindSession({
	getToolDefinition: () => undefined,
	extensionRunner: { resolveToolRenderers: (_name: string, base: () => undefined) => base() },
	sessionManager: { getCwd: () => agentDir },
} as unknown as AgentSession);

const timers: ReturnType<typeof setInterval>[] = [];

function startLoad(): void {
	for (let index = 0; index < load.widgets; index++) {
		customUi.setWidget(
			`bench-widget-${index}`,
			(tui) => {
				let tick = 0;
				const timer = setInterval(() => {
					tick++;
					tui.requestRender();
				}, 1000 / Math.max(1, load.widgetHz));
				timers.push(timer);
				return {
					render(width: number): string[] {
						counters.widgetRenders++;
						busyFor(load.widgetCostMs);
						return widgetLines(index, tick, width);
					},
					invalidate() {},
					dispose() {
						clearInterval(timer);
					},
				};
			},
			"belowEditor",
		);
	}
	if (load.broadcastHz > 0) {
		timers.push(
			setInterval(() => {
				counters.broadcasts++;
				customUi.requestRender();
			}, 1000 / load.broadcastHz),
		);
	}
}

function handleControl(control: BenchControl): void {
	switch (control.type) {
		case "bench_open_dialog": {
			const ui = { custom: customUi.custom.bind(customUi) } as unknown as ExtensionUIContext;
			void presentQuestionnaire(ui, benchmarkQuestionnaire());
			return;
		}
		case "bench_start_load":
			startLoad();
			return;
		case "bench_reset_counters":
			for (const key of Object.keys(counters) as (keyof EngineCounters)[]) counters[key] = 0;
			return;
		case "bench_counters":
			writeRawStdout(`${JSON.stringify({ type: "bench_counters", counters })}\n`);
			return;
	}
}

const handleLine = async (line: string): Promise<void> => {
	if (line.startsWith('{"type":"bench_')) {
		handleControl(JSON.parse(line) as BenchControl);
		return;
	}
	if (customUi.handleLine(line)) return;
	renderService.handleLine(line);
};

attachJsonlLineReader(process.stdin, createRpcInputScheduler(handleLine), { maxBytesPerTurn: 256 * 1024 });
const exit = (): never => {
	for (const timer of timers) clearInterval(timer);
	customUi.dispose();
	renderService.dispose();
	process.exit(0);
};
process.stdin.on("end", exit);
// The driver closes the pipe as soon as a run is measured; frames still queued behind a backlog have no reader.
process.stdout.on("error", exit);
writeRawStdout(`${JSON.stringify({ type: "bench_ready" })}\n`);
