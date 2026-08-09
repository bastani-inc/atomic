import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const showModelsSelector = Reflect.get(InteractiveModeBase.prototype, "showModelsSelector") as (this: object) => void;

type RefreshResult = { aborted: boolean; errors: ReadonlyMap<string, Error> };

interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: string;
}

interface OpenSelectorOptions {
	configuredPatterns?: string[];
	scopedModels?: ScopedModel[];
}

function model(id: string, name: string): Model<Api> {
	return { provider: "cached-provider", id, name } as Model<Api>;
}

async function openSelector(initialModels: readonly Model<Api>[], options: OpenSelectorOptions = {}) {
	let snapshot = initialModels;
	let configuredPatterns = options.configuredPatterns;
	let snapshotError: Error | undefined;
	let completeRefresh: ((result: RefreshResult) => void) | undefined;
	let refreshSignal: AbortSignal | undefined;
	let selector: ScopedModelsSelectorComponent | undefined;
	let dispose: (() => void) | undefined;
	const done = vi.fn();
	const setScopedModels = vi.fn();
	const setEnabledModels = vi.fn((patterns: string[] | undefined) => {
		configuredPatterns = patterns;
	});
	const refresh = vi.fn(
		(options: { signal?: AbortSignal }) =>
			new Promise<RefreshResult>((resolve) => {
				refreshSignal = options.signal;
				completeRefresh = resolve;
			}),
	);
	const context = {
		session: {
			scopedModels: options.scopedModels ?? [],
			modelRuntime: {
				getAvailableSnapshot: () => {
					if (snapshotError) throw snapshotError;
					return snapshot;
				},
				refresh,
			},
			setScopedModels,
		},
		settingsManager: {
			getEnabledModels: () => configuredPatterns,
			setEnabledModels,
		},
		showSelector: (
			factory: (done: () => void) => {
				component: ScopedModelsSelectorComponent;
				focus: ScopedModelsSelectorComponent;
				dispose?: () => void;
			},
		) => {
			const created = factory(() => {
				dispose?.();
				done();
			});
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		showStatus: vi.fn(),
	};

	showModelsSelector.call(context);
	if (!selector) throw new Error("Expected scoped-model selector to open");
	await vi.waitFor(() => expect(refreshSignal).toBeInstanceOf(AbortSignal));
	return {
		done,
		get refreshSignal() {
			return refreshSignal;
		},
		selector,
		setScopedModels,
		setEnabledModels,
		complete(
			models: readonly Model<Api>[],
			result: RefreshResult,
			completeOptions: { snapshotError?: Error } = {},
		): void {
			snapshot = models;
			snapshotError = completeOptions.snapshotError;
			if (!completeRefresh) throw new Error("Expected model refresh to start");
			completeRefresh(result);
		},
	};
}

describe("scoped models cache-first refresh", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => vi.restoreAllMocks());

	it("renders cached models immediately and updates after the background refresh", async () => {
		const cached = model("cached", "Cached");
		const refreshed = model("refreshed", "Refreshed");
		const refresh = await openSelector([cached]);

		const initial = stripAnsi(refresh.selector.render(100).join("\n"));
		expect(initial).toContain("cached");
		expect(initial).toContain("Refreshing model catalogs…");
		expect(initial).not.toContain("refreshed");

		refresh.complete([cached, refreshed], { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("refreshed");
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("does not mutate the session scope when the refresh completes before a selection", async () => {
		const cached = model("cached", "Cached");
		const refreshed = model("refreshed", "Refreshed");
		const refresh = await openSelector([cached], { scopedModels: [{ model: cached }] });

		refresh.complete([refreshed], { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			expect(stripAnsi(refresh.selector.render(100).join("\n"))).toContain("refreshed");
		});

		expect(refresh.setScopedModels).not.toHaveBeenCalled();
	});

	it("uses settings saved while refresh is in flight", async () => {
		const cached = model("cached", "Cached");
		const refreshed = model("refreshed", "Refreshed");
		const refresh = await openSelector([cached], { configuredPatterns: ["cached-provider/*"] });

		refresh.selector.handleInput("\x13");
		expect(refresh.setEnabledModels).toHaveBeenCalledWith(undefined);

		refresh.complete([cached, refreshed], { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("all enabled");
		});
	});

	it("keeps a user-selected cached scope when refresh drops its model", async () => {
		const cached = model("cached", "Cached");
		const otherCached = model("other", "Other Cached");
		const refreshed = model("refreshed", "Refreshed");
		const refresh = await openSelector([cached, otherCached]);

		refresh.selector.handleInput("\r");
		expect(refresh.setScopedModels).toHaveBeenLastCalledWith([{ model: cached, thinkingLevel: undefined }]);

		refresh.complete([refreshed], { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("cached-provider/cached [unavailable]");
			expect(rendered).toContain("refreshed");
		});

		expect(refresh.setScopedModels).toHaveBeenCalledTimes(1);
	});

	it("does not report a cancelled model-runtime refresh as successful", async () => {
		const refresh = await openSelector([model("cached", "Cached")]);

		refresh.complete([model("cached", "Cached")], { aborted: true, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("Model refresh was cancelled; showing cached models.");
			expect(rendered).not.toContain("Model catalogs refreshed.");
		});
	});

	it("keeps cached models visible when publishing the refreshed snapshot fails", async () => {
		const cached = model("cached", "Cached");
		const refresh = await openSelector([cached]);

		refresh.complete(
			[cached],
			{ aborted: false, errors: new Map() },
			{ snapshotError: new Error("snapshot failed") },
		);
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("cached");
			expect(rendered).toContain("Could not update cached models; showing cached models.");
		});
	});

	it("cancels the background refresh when the selector closes", async () => {
		const refresh = await openSelector([model("cached", "Cached")]);

		refresh.selector.handleInput("\x1b");

		expect(refresh.refreshSignal?.aborted).toBe(true);
		expect(refresh.done).toHaveBeenCalledOnce();
	});
});
