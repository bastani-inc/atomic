import assert from "node:assert/strict";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { HuggingFaceModel } from "../src/extensions/llama/huggingface.ts";
import { type LlamaUi, showLlamaUi } from "../src/extensions/llama/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";

function model(id: string): HuggingFaceModel {
	return { id, downloads: 1000 };
}

function selectedId(view: Component): string | undefined {
	const row = stripAnsi(view.render(120).join("\n"))
		.split("\n")
		.find((line) => line.includes("→ "));
	return row?.split("→ ")[1]?.split(" ")[0];
}

// Opens the Hugging Face search with each query's results held until the test resolves them.
async function openSearch(): Promise<{
	view: Component;
	type: (text: string) => Promise<void>;
	finishSearch: (query: string, results: HuggingFaceModel[]) => Promise<void>;
	selected: Promise<string | undefined>;
}> {
	const pending = new Map<string, (results: HuggingFaceModel[]) => void>();
	const search = (query: string) =>
		new Promise<HuggingFaceModel[]>((resolve) => {
			pending.set(query, resolve);
		});
	let view: Component | undefined;
	let resolveSelected: (model: string | undefined) => void = () => {};
	const selected = new Promise<string | undefined>((resolve) => {
		resolveSelected = resolve;
	});
	const ctx = {
		ui: {
			custom: (factory: (tui: TUI, th: typeof theme, kb: KeybindingsManager, done: () => void) => Component) => {
				view = factory({ requestRender: () => {} } as unknown as TUI, theme, new KeybindingsManager(), () => {});
				return Promise.resolve();
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	void showLlamaUi(ctx, async (ui: LlamaUi) => {
		resolveSelected(await ui.searchModels(search));
	});
	if (!view) throw new Error("llama UI was not shown");
	const shown = view;
	const type = async (text: string) => {
		for (const char of text) shown.handleInput?.(char);
		await vi.advanceTimersByTimeAsync(500);
	};
	const finishSearch = async (query: string, results: HuggingFaceModel[]) => {
		const resolve = pending.get(query);
		if (!resolve) throw new Error(`no search pending for ${query}`);
		resolve(results);
		await vi.advanceTimersByTimeAsync(0);
	};
	return { view: shown, type, finishSearch, selected };
}

describe("llama.cpp Hugging Face search (pi #11810)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const firstResults = [model("qwen/a-GGUF"), model("qwen/b-GGUF"), model("qwen/c-GGUF")];

	it("keeps the browsed model selected when the next search lands", async () => {
		const { view, type, finishSearch, selected } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");
		view.handleInput?.(DOWN);
		view.handleInput?.(DOWN);
		assert.equal(selectedId(view), "qwen/c-GGUF");

		await finishSearch("qwe", [model("qwen/new-GGUF"), ...firstResults]);

		assert.equal(selectedId(view), "qwen/c-GGUF");
		view.handleInput?.(ENTER);
		assert.equal(await selected, "qwen/c-GGUF");
	});

	it("selects the best match when the user did not browse", async () => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");

		await finishSearch("qwe", [model("qwen/new-GGUF"), ...firstResults]);

		assert.equal(selectedId(view), "qwen/new-GGUF");
	});

	it("selects the best match when the browsed model is not in the new results", async () => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");
		view.handleInput?.(DOWN);

		await finishSearch("qwe", [model("qwen/new-GGUF"), model("qwen/a-GGUF")]);

		assert.equal(selectedId(view), "qwen/new-GGUF");
	});

	it.each([
		["up", UP],
		["page down", PAGE_DOWN],
	])("keeps the model selected with %s when the next search lands", async (_name, key) => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");
		view.handleInput?.(key);
		assert.equal(selectedId(view), "qwen/c-GGUF");

		await finishSearch("qwe", [model("qwen/new-GGUF"), ...firstResults]);

		assert.equal(selectedId(view), "qwen/c-GGUF");
	});

	it("moves the selection to the last remaining result when typing filters out the rows below it", async () => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", [
			model("qwen/p1"),
			model("qwen/p2"),
			model("qwen/q1"),
			model("qwen/q2"),
			model("qwen/q3"),
		]);
		view.handleInput?.(UP);
		assert.equal(selectedId(view), "qwen/q3");

		await type("en/p");

		assert.equal(selectedId(view), "qwen/p2");
	});
});
