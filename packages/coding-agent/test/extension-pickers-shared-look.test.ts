import assert from "node:assert/strict";
import { type Component, setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { LlamaModelInfo } from "../src/extensions/llama/client.js";
import type { HuggingFaceModel } from "../src/extensions/llama/huggingface.js";
import { type LlamaUi, showLlamaUi } from "../src/extensions/llama/ui.js";
import { McpManagerView, type McpMenu } from "../src/extensions/mcp/ui.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const tui = { requestRender: vi.fn() } as unknown as TUI;
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

function lines(view: Component, width = 100): string[] {
	return stripAnsi(view.render(width).join("\n"))
		.replace(/\x1b_[^\x07]*\x07/g, "")
		.split("\n");
}

function hint(view: Component, width = 100): string {
	const rendered = lines(view, width).filter((line) => line.trim() !== "" && !/^─+$/.test(line.trim()));
	return rendered.at(-1)?.trim() ?? "";
}

function llamaModel(id: string, status: LlamaModelInfo["status"]["value"] = "unloaded"): LlamaModelInfo {
	return { id, status: { value: status } } as LlamaModelInfo;
}

async function openLlama(run: (ui: LlamaUi) => Promise<void>): Promise<Component> {
	let view: Component | undefined;
	const ctx = {
		ui: {
			custom: (factory: (tui: TUI, th: typeof theme, kb: KeybindingsManager, done: () => void) => Component) => {
				view = factory(tui, theme, new KeybindingsManager(), () => {});
				return Promise.resolve();
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	void showLlamaUi(ctx, run);
	await Promise.resolve();
	if (!view) throw new Error("llama UI was not shown");
	return view;
}

describe("MCP manager menus share the picker look (#5224)", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("rows carry the ∀ marker and one hint line lists exactly the keys that work", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		void view.menu(() => ({
			title: "MCP servers",
			details: "2 servers",
			items: [
				{ value: "issues", label: "issues", description: "connected" },
				{ value: "search", label: "search", description: "needs sign-in" },
			],
			confirmLabel: "open",
			cancelLabel: "close",
		}));
		const rendered = lines(view);
		assert.ok(rendered.some((line) => line.includes("∀ issues")));
		assert.ok(!rendered.some((line) => line.includes("→ ")));
		assert.equal(hint(view), "↑↓ select · enter open · esc close · ? keys");
	});

	test("a long server list gets a search box, and typing filters it", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const items = Array.from({ length: 20 }, (_, index) => ({ value: `server-${index}`, label: `server-${index}` }));
		const result = view.menu(() => ({ title: "MCP servers", items, confirmLabel: "open", cancelLabel: "close" }));
		assert.ok(lines(view).some((line) => line.includes("⌕")));
		for (const char of "server-17") view.handleInput(char);
		assert.deepEqual(
			lines(view)
				.filter((line) => /server-\d+/.test(line) && !line.includes("⌕"))
				.map((line) => line.trim()),
			["∀ server-17"],
		);
		view.handleInput("\r");
		assert.equal(await result, "server-17");
	});

	test("an error shows in the error colour under the list, and a rebuild keeps the selected server", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		let error: string | undefined;
		let notify: (() => void) | undefined;
		const items = [
			{ value: "a", label: "a" },
			{ value: "b", label: "b" },
			{ value: "c", label: "c" },
		];
		const result = view.menu(
			() => ({ title: "MCP servers", items, error, confirmLabel: "open", cancelLabel: "close" }),
			(listener) => {
				notify = listener;
				return () => {
					notify = undefined;
				};
			},
		);
		view.handleInput(DOWN);
		error = "search: connection refused";
		notify?.();
		const raw = view.render(100).join("\n");
		assert.ok(raw.includes(theme.fg("error", "search: connection refused")));
		assert.ok(lines(view).some((line) => line.includes("∀ b")));
		view.handleInput("\r");
		assert.equal(await result, "b");
		assert.equal(notify, undefined);
	});

	test("live menu rebuilds update empty text and action labels (#5256)", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		let menu: McpMenu = {
			title: "MCP server docs",
			items: [
				{ value: "reconnect", label: "Reconnect" },
				{ value: "disable", label: "Disable" },
			],
			confirmLabel: "select",
			cancelLabel: "back",
		};
		let notify: (() => void) | undefined;
		const result = view.menu(
			() => menu,
			(listener) => {
				notify = listener;
				return () => {
					notify = undefined;
				};
			},
		);
		assert.ok(lines(view).some((line) => line.includes("∀ Reconnect")));

		menu = {
			title: "docs",
			items: [],
			empty: "This server is no longer configured.",
			confirmLabel: "",
			cancelLabel: "return",
		};
		notify?.();
		assert.ok(lines(view).some((line) => line.includes("This server is no longer configured.")));
		assert.equal(hint(view), "esc return · ? keys");

		menu = {
			title: "docs",
			items: [{ value: "reconnect", label: "Reconnect" }],
			confirmLabel: "retry",
			cancelLabel: "close",
		};
		notify?.();
		assert.equal(hint(view), "enter retry · esc close · ? keys");

		menu = { title: "docs", items: [], confirmLabel: "", cancelLabel: "back" };
		notify?.();
		assert.ok(lines(view).some((line) => line.includes("Nothing to show.")));
		view.handleInput(ESCAPE);
		assert.equal(await result, undefined);
		assert.equal(notify, undefined);
	});

	test("recomputes whether to show the search box when a live menu grows or shrinks (#5256)", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const makeMenu = (count: number): McpMenu => ({
			title: "MCP servers",
			items: Array.from({ length: count }, (_, index) => ({
				value: `server-${index}`,
				label: `server-${index}`,
			})),
			confirmLabel: "open",
			cancelLabel: "close",
		});
		let menu = makeMenu(3);
		let notify: (() => void) | undefined;
		const result = view.menu(
			() => menu,
			(listener) => {
				notify = listener;
				return () => {
					notify = undefined;
				};
			},
		);
		assert.ok(!lines(view).some((line) => line.includes("⌕")));
		assert.equal(hint(view), "↑↓ select · enter open · esc close · ? keys");

		menu = makeMenu(20);
		notify?.();
		assert.ok(lines(view).some((line) => line.includes("⌕")));
		assert.equal(hint(view), "↑↓ select · enter open · type to search · esc close");
		for (const ch of "server-18") view.handleInput(ch);
		assert.deepEqual(
			lines(view)
				.filter((line) => /server-\d+/.test(line) && !line.includes("⌕"))
				.map((line) => line.trim()),
			["∀ server-18"],
		);

		menu = makeMenu(2);
		notify?.();
		assert.ok(!lines(view).some((line) => line.includes("⌕")));
		assert.equal(hint(view), "↑↓ select · enter open · esc close · ? keys");
		assert.deepEqual(
			lines(view)
				.filter((line) => /server-\d+/.test(line))
				.map((line) => line.trim()),
			["∀ server-0", "server-1"],
		);
		view.handleInput(ESCAPE);
		assert.equal(await result, undefined);
	});

	test("an empty menu says so and offers only the cancel key", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const result = view.menu(() => ({
			title: "MCP servers",
			items: [],
			empty: "No servers configured.",
			confirmLabel: "open",
			cancelLabel: "close",
		}));
		assert.ok(lines(view).some((line) => line.includes("No servers configured.")));
		assert.equal(hint(view), "esc close · ? keys");
		view.handleInput("\r");
		view.handleInput(ESCAPE);
		assert.equal(await result, undefined);
	});
});

describe("llama.cpp pickers share the picker look (#5224)", () => {
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

	test("the models list shows the server under the title, ∀ rows and one hint line", async () => {
		let action: unknown;
		const view = await openLlama(async (ui) => {
			action = await ui.showModels("http://127.0.0.1:8080", [llamaModel("b"), llamaModel("a", "loaded")]);
		});
		const rendered = lines(view);
		assert.ok(rendered.some((line) => line.trim() === "llama.cpp models"));
		assert.ok(rendered.some((line) => line.trim() === "http://127.0.0.1:8080"));
		assert.ok(rendered.some((line) => line.includes("∀ a")));
		assert.equal(hint(view), "↑↓ select · enter load/unload/download · esc close · ? keys");
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput("\r");
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(action, { type: "download" });
	});

	test("truncates long model ids at 80 columns so the loaded status and download description stay visible (#5256)", async () => {
		const models: LlamaModelInfo[] = [
			{
				id: "bartowski/Meta-Llama-3.1-70B-Instruct-GGUF:Meta-Llama-3.1-70B-Instruct-Q4_K_M",
				status: { value: "loaded" },
				meta: { n_ctx: 32768 },
			} as LlamaModelInfo,
			llamaModel("unsloth/Qwen3-Coder-480B-A35B-Instruct-GGUF:Q4_K_M", "unloaded"),
			llamaModel("ggml-org/gemma-3-4b-it-GGUF:Q4_K_M", "unloaded"),
		];
		const view = await openLlama(async (ui) => {
			await ui.showModels("http://127.0.0.1:8080", models);
		});
		const rendered80 = lines(view, 80);
		const loadedRow = rendered80.find((line) => line.includes("∀ ")) ?? "";
		assert.match(
			loadedRow,
			/∀ bartowski\/Meta-Llama-3\.1-70B-Instruct-GGUF:Meta-L\.\.\. {2}loaded · 32\.8k context *$/,
			rendered80.join("\n"),
		);
		const downloadRow = rendered80.find((line) => line.includes("Download model…")) ?? "";
		assert.ok(downloadRow.includes("Hugging Face"), rendered80.join("\n"));
	});

	test("a choice shows its message under the title and picks with enter", async () => {
		let choice: string | undefined;
		const view = await openLlama(async (ui) => {
			choice = await ui.select("llama.cpp unavailable\nhttp://127.0.0.1:8080", ["Retry", "Close"]);
		});
		const rendered = lines(view);
		assert.ok(rendered.some((line) => line.trim() === "llama.cpp unavailable"));
		assert.ok(rendered.some((line) => line.trim() === "http://127.0.0.1:8080"));
		assert.equal(hint(view), "↑↓ select · enter choose · esc cancel · ? keys");
		view.handleInput(DOWN);
		view.handleInput("\r");
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(choice, "Close");
	});

	test("the Hugging Face search uses the search box, ∀ rows, more indicators and live keys", async () => {
		const pending = new Map<string, (results: HuggingFaceModel[]) => void>();
		const view = await openLlama(async (ui) => {
			await ui.searchModels(
				(query) =>
					new Promise<HuggingFaceModel[]>((resolve) => {
						pending.set(query, resolve);
					}),
			);
		});
		assert.ok(lines(view).some((line) => line.includes("⌕ Model name or owner/repository[:quant]")));
		assert.equal(hint(view), "type to search · esc back");
		for (const char of "qw") view.handleInput(char);
		await vi.advanceTimersByTimeAsync(500);
		pending.get("qw")?.(Array.from({ length: 15 }, (_, index) => ({ id: `qwen/m${index}-GGUF`, downloads: 10 })));
		await vi.advanceTimersByTimeAsync(0);
		const rendered = lines(view);
		assert.ok(rendered.some((line) => line.includes("∀ qwen/m0-GGUF")));
		assert.ok(rendered.some((line) => line.trim() === "↓ 5 more"));
		assert.ok(!rendered.some((line) => /\(\d+\/\d+\)/.test(line)));
		assert.equal(hint(view), "↑↓ select · enter download · type to search · esc back");
	});
});
