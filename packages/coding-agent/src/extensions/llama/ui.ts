import {
	type Component,
	Container,
	type Focusable,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { FramedSelector, type SelectorItem } from "../../modes/interactive/components/selector.ts";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { formatTokenCount } from "../../utils/token-count.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.js";
import type { HuggingFaceModel } from "./huggingface.js";
import { HuggingFaceSearch } from "./huggingface-ui.js";

const DOWNLOAD_VALUE = "\0download";
const MAX_VISIBLE_ITEMS = 12;

type InputHandler = Pick<Component, "handleInput" | "capturesViewportInput">;

export type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

interface ProgressState extends LlamaProgress {
	title: string;
	model: string;
}

function contextLabel(model: LlamaModelInfo): string | undefined {
	const context = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	if (context) return formatTokenCount(context);
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] !== "--ctx-size" && args[index] !== "-c" && args[index] !== "-ctx") continue;
		const value = Number(args[index + 1]);
		if (Number.isFinite(value) && value > 0) return formatTokenCount(value);
	}
	return undefined;
}

function modelDescription(model: LlamaModelInfo): string {
	const details: string[] = [];
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	if (loaded) details.push("loaded");
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	const context = loaded ? contextLabel(model) : undefined;
	if (context) details.push(`${context} context`);
	return details.join(" · ");
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

export interface LlamaUi {
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	showStatus(title: string, message: string): void;
	progress(state: ProgressState): Promise<void>;
	updateProgress(state: ProgressState): void;
}

class LlamaView implements LlamaUi, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly searchCache = new Map<string, HuggingFaceModel[]>();
	private content: Component;
	private inputHandler: InputHandler | undefined;
	private inputTarget: Focusable | undefined;
	private progressPromise: Promise<void> | undefined;
	private progressResolver: (() => void) | undefined;
	private showingProgress = false;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = frame(theme, "llama.cpp models", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	get capturesViewportInput(): boolean {
		return this.inputHandler?.capturesViewportInput === true;
	}

	private setContent(content: Component, inputHandler?: InputHandler, inputTarget?: Focusable): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.progressPromise = undefined;
		this.progressResolver = undefined;
		this.showingProgress = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		const sorted = [...models].sort((left, right) => {
			const loaded = Number(right.status.value === "loaded") - Number(left.status.value === "loaded");
			return loaded || left.id.localeCompare(right.id);
		});
		const byId = new Map(sorted.map((model) => [model.id, model]));
		const modelItems = sorted.map((model) => ({
			id: model.id,
			value: model.id,
			label: model.id,
			description: modelDescription(model),
		}));
		// A long model id gives way to its status and context size, which stay whole.
		const statusWidth = Math.max(0, ...modelItems.map((item) => visibleWidth(item.description)));
		const items: SelectorItem<string>[] = [
			...modelItems,
			{
				id: DOWNLOAD_VALUE,
				value: DOWNLOAD_VALUE,
				label: "Download model…",
				description: "Hugging Face owner/repository[:quant]",
			},
		];
		return new Promise((resolve) => {
			const picker = new FramedSelector<string>({
				title: "llama.cpp models",
				subtitle: serverUrl,
				items,
				search: items.length > MAX_VISIBLE_ITEMS,
				maxVisible: MAX_VISIBLE_ITEMS,
				confirmLabel: "load/unload/download",
				cancelLabel: "close",
				...(statusWidth > 0 ? { minDescriptionWidth: statusWidth } : {}),
				keybindings: this.keybindings,
				onSelect: (item) => {
					if (item.value === DOWNLOAD_VALUE) resolve({ type: "download" });
					else {
						const model = byId.get(item.value);
						if (model) resolve({ type: "model", model });
					}
				},
				onCancel: () => resolve({ type: "close" }),
			});
			this.setContent(picker, picker, picker);
		});
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		const [heading = "", ...details] = title.split("\n");
		return new Promise((resolve) => {
			const picker = new FramedSelector<string>({
				title: heading,
				subtitle: details.length > 0 ? details.join("\n") : undefined,
				items: options.map((option, index) => ({ id: String(index), value: option, label: option })),
				maxVisible: MAX_VISIBLE_ITEMS,
				keybindings: this.keybindings,
				onSelect: (item) => resolve(item.value),
				onCancel: () => resolve(undefined),
			});
			this.setContent(picker, picker, picker);
		});
	}

	async confirm(title: string, message: string): Promise<boolean> {
		return (await this.select(`${title}\n${message}`, ["Yes", "No"])) === "Yes";
	}

	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		const choice = await this.select(`llama.cpp unavailable\n${serverUrl}\n\n${message}`, ["Retry", "Close"]);
		return choice === "Retry" ? "retry" : "close";
	}

	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const component = new HuggingFaceSearch(
				this.tui,
				this.theme,
				this.keybindings,
				search,
				this.searchCache,
				resolve,
			);
			this.setContent(frame(this.theme, "Download model", [new Spacer(1), component]), component, component);
		});
	}

	showStatus(title: string, message: string): void {
		this.setContent(frame(this.theme, title, [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)]));
	}

	progress(state: ProgressState): Promise<void> {
		if (!this.progressPromise) {
			this.progressPromise = new Promise((resolve) => {
				this.progressResolver = resolve;
			});
		}
		this.showingProgress = true;
		this.updateProgress(state);
		return this.progressPromise;
	}

	updateProgress(state: ProgressState): void {
		if (!this.showingProgress) return;
		const body = [
			new Text(this.theme.fg("text", state.model), 1, 0),
			new Spacer(1),
			new Text(this.theme.fg("muted", state.message), 1, 0),
		];
		if (state.ratio !== undefined) {
			const available = 40;
			const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
			body.push(
				new Text(
					this.theme.fg(
						"accent",
						`${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
					),
					1,
					0,
				),
			);
		}
		if (state.detail) body.push(new Text(this.theme.fg("dim", state.detail), 1, 0));
		this.content = frame(this.theme, state.title, body, keyHint("tui.select.cancel", "stop"));
		this.inputHandler = undefined;
		this.tui.requestRender();
	}

	handleInput(data: string): boolean {
		if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
			const resolve = this.progressResolver;
			this.progressPromise = undefined;
			this.progressResolver = undefined;
			resolve();
			return true;
		}
		if (!this.inputHandler?.handleInput) return false;
		this.inputHandler.handleInput(data);
		this.tui.requestRender();
		return true;
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new LlamaView(tui, theme, keybindings);
		void run(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}

export async function runWithProgress<T>(
	ui: LlamaUi,
	options: {
		title: string;
		model: string;
		initialMessage: string;
		cancelTitle: string;
		cancelMessage: string;
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		cancel(): Promise<void>;
	},
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	const controller = new AbortController();
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	const settled = options
		.run(controller.signal, (progress) => {
			Object.assign(state, progress);
			ui.updateProgress(state);
		})
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	let completed = false;
	settled.finally(() => {
		completed = true;
	});

	while (!completed) {
		const outcome = await Promise.race([
			settled.then(() => "settled" as const),
			ui.progress(state).then(() => "stop" as const),
		]);
		if (outcome === "settled") break;
		const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
		if (!stop || completed) continue;
		try {
			await options.cancel();
		} finally {
			controller.abort(new Error("Cancelled"));
		}
		await settled;
		return { cancelled: true };
	}

	const result = await settled;
	if (!result.ok) throw result.error;
	return { cancelled: false, value: result.value };
}
