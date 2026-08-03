import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "../src/core/model-refresh-timeout.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";

const cachedModel = {
	provider: "cached-provider",
	id: "cached-model",
	name: "Cached Model",
} as Model<Api>;

const refreshedModel = {
	provider: "cached-provider",
	id: "refreshed-model",
	name: "Refreshed Model",
} as Model<Api>;

type RefreshOptions = { allowNetwork?: boolean; signal?: AbortSignal };
type RefreshResult = Awaited<ReturnType<ModelRuntime["refresh"]>>;

type ModelRuntimeStub = {
	refresh: (options: RefreshOptions) => Promise<RefreshResult>;
	getAvailableSnapshot: () => readonly Model<Api>[];
};

function createMode(
	refresh: ModelRuntimeStub["refresh"],
	getAvailableSnapshot: ModelRuntimeStub["getAvailableSnapshot"],
	scopedModels: readonly { model: Model<Api> }[] = [],
) {
	return {
		getModelCandidates: InteractiveModeBase.prototype.getModelCandidates,
		session: {
			scopedModels,
			modelRuntime: { refresh, getAvailableSnapshot },
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("interactive model routing refresh bounds", () => {
	it("returns the current cached snapshot after a cancellation-blind refresh deadline", async () => {
		vi.useFakeTimers();
		let currentSnapshot: readonly Model<Api>[] = [cachedModel];
		let observedSignal: AbortSignal | undefined;
		const refresh = vi.fn(({ signal }: RefreshOptions) => {
			observedSignal = signal;
			return new Promise<never>(() => {});
		});
		const mode = createMode(refresh, () => currentSnapshot);
		const candidates = InteractiveModeBase.prototype.getModelCandidates.call(mode as never);
		currentSnapshot = [refreshedModel];

		await vi.advanceTimersByTimeAsync(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);

		await expect(candidates).resolves.toEqual([refreshedModel]);
		expect(observedSignal).toBeInstanceOf(AbortSignal);
		expect(observedSignal?.aborted).toBe(true);
	});

	it("keeps an exact cached model match usable after the refresh deadline", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn(() => new Promise<never>(() => {}));
		const mode = createMode(refresh, () => [cachedModel]);
		const match = InteractiveModeBase.prototype.findExactModelMatch.call(
			mode as never,
			"cached-provider/cached-model",
		);

		await vi.advanceTimersByTimeAsync(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);

		await expect(match).resolves.toBe(cachedModel);
	});

	it("returns cached candidates when refresh rejects", async () => {
		const refresh = vi.fn(async () => {
			throw new Error("catalog unavailable");
		});
		const mode = createMode(refresh, () => [cachedModel]);

		await expect(InteractiveModeBase.prototype.getModelCandidates.call(mode as never)).resolves.toEqual([
			cachedModel,
		]);
	});

	it("does not expose a late refresh rejection as an unhandled rejection", async () => {
		vi.useFakeTimers();
		let rejectRefresh!: (reason?: Error) => void;
		const refreshPromise = new Promise<never>((_, reject) => {
			rejectRefresh = reject;
		});
		const refresh = vi.fn(() => refreshPromise);
		const mode = createMode(refresh, () => [cachedModel]);
		const candidates = InteractiveModeBase.prototype.getModelCandidates.call(mode as never);
		const unhandledRejections: Error[] = [];
		const onUnhandledRejection = (reason: Error) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		await vi.advanceTimersByTimeAsync(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);
		await expect(candidates).resolves.toEqual([cachedModel]);
		rejectRefresh(new Error("late catalog failure"));
		await vi.runAllTimersAsync();
		await Promise.resolve();

		process.off("unhandledRejection", onUnhandledRejection);
		expect(unhandledRejections).toEqual([]);
	});

	it("returns scoped models without refreshing", async () => {
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
		const mode = createMode(refresh, () => [], [{ model: cachedModel }]);

		await expect(InteractiveModeBase.prototype.getModelCandidates.call(mode as never)).resolves.toEqual([
			cachedModel,
		]);
		expect(refresh).not.toHaveBeenCalled();
	});
});
