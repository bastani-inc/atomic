import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function successfulRefresh(): ModelsRefreshResult {
	return { aborted: false, errors: new Map() };
}

describe("interactive model catalog refresh", () => {
	it("shares one runtime refresh between concurrent callers", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const runtime = { refresh: vi.fn((_options?: ModelsRefreshOptions) => deferred.promise) };
		const firstController = new AbortController();
		const secondController = new AbortController();

		const first = refreshModelCatalogs(runtime, { signal: firstController.signal });
		const second = refreshModelCatalogs(runtime, { signal: secondController.signal });

		expect(runtime.refresh).toHaveBeenCalledOnce();
		deferred.resolve(successfulRefresh());
		await expect(first).resolves.toEqual(successfulRefresh());
		await expect(second).resolves.toEqual(successfulRefresh());
	});

	it("keeps the shared refresh alive when one caller stops waiting", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		let refreshSignal: AbortSignal | undefined;
		const runtime = {
			refresh: vi.fn((options?: ModelsRefreshOptions) => {
				refreshSignal = options?.signal;
				return deferred.promise;
			}),
		};
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = refreshModelCatalogs(runtime, { signal: firstController.signal });
		const second = refreshModelCatalogs(runtime, { signal: secondController.signal });

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(refreshSignal?.aborted).toBe(false);

		deferred.resolve(successfulRefresh());
		await expect(second).resolves.toEqual(successfulRefresh());
	});

	it("aborts an abandoned refresh in the aborting tick and allows a later refresh to start", async () => {
		const refreshSignals: AbortSignal[] = [];
		const runtime = {
			refresh: vi.fn((options?: ModelsRefreshOptions) => {
				if (options?.signal) refreshSignals.push(options.signal);
				return new Promise<ModelsRefreshResult>(() => {});
			}),
		};
		const firstController = new AbortController();
		const first = refreshModelCatalogs(runtime, { signal: firstController.signal });

		firstController.abort();
		// Synchronous: a closing selector cancels the network work it started
		// before the next render, exactly as a direct runtime.refresh() did.
		expect(refreshSignals[0]?.aborted).toBe(true);
		await expect(first).rejects.toMatchObject({ name: "AbortError" });

		const secondController = new AbortController();
		const second = refreshModelCatalogs(runtime, { signal: secondController.signal });
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		secondController.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
	});

	it("refuses to answer a different catalog request with an in-flight one", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const requested: Array<boolean | undefined> = [];
		const runtime = {
			refresh: vi.fn((options?: ModelsRefreshOptions) => {
				requested.push(options?.allowNetwork);
				return deferred.promise;
			}),
		};
		const controller = new AbortController();

		const networked = refreshModelCatalogs(runtime, { allowNetwork: true, signal: controller.signal });
		const cached = refreshModelCatalogs(runtime, { allowNetwork: false, signal: controller.signal });
		const runtimeDefault = refreshModelCatalogs(runtime, { signal: controller.signal });

		expect(runtime.refresh).toHaveBeenCalledTimes(3);
		expect(requested).toEqual([true, false, undefined]);

		deferred.resolve(successfulRefresh());
		await Promise.all([networked, cached, runtimeDefault]);
	});

	it("shares nothing across separate runtimes", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const first = { refresh: vi.fn((_options?: ModelsRefreshOptions) => deferred.promise) };
		const second = { refresh: vi.fn((_options?: ModelsRefreshOptions) => deferred.promise) };
		const controller = new AbortController();

		const firstRefresh = refreshModelCatalogs(first, { signal: controller.signal });
		const secondRefresh = refreshModelCatalogs(second, { signal: controller.signal });

		expect(first.refresh).toHaveBeenCalledOnce();
		expect(second.refresh).toHaveBeenCalledOnce();

		deferred.resolve(successfulRefresh());
		await Promise.all([firstRefresh, secondRefresh]);
	});

	it("rejects a caller whose signal already aborted without starting work", async () => {
		const runtime = { refresh: vi.fn((_options?: ModelsRefreshOptions) => Promise.resolve(successfulRefresh())) };
		const controller = new AbortController();
		controller.abort();

		expect(() => refreshModelCatalogs(runtime, { signal: controller.signal })).toThrow();
		expect(runtime.refresh).not.toHaveBeenCalled();
	});

	it("starts a fresh refresh once the shared one has settled", async () => {
		const first = createDeferred<ModelsRefreshResult>();
		const second = createDeferred<ModelsRefreshResult>();
		const deferrals = [first, second];
		const runtime = {
			refresh: vi.fn((_options?: ModelsRefreshOptions) => (deferrals.shift() ?? first).promise),
		};
		const controller = new AbortController();

		const firstRefresh = refreshModelCatalogs(runtime, { signal: controller.signal });
		first.resolve(successfulRefresh());
		await expect(firstRefresh).resolves.toEqual(successfulRefresh());

		const secondRefresh = refreshModelCatalogs(runtime, { signal: controller.signal });
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		second.resolve(successfulRefresh());
		await expect(secondRefresh).resolves.toEqual(successfulRefresh());
	});
});
