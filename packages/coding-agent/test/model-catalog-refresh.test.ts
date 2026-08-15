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

/**
 * A runtime stub carrying the network policy an omitted `allowNetwork` resolves
 * to and the single catalog-inputs generation a real `ModelRuntime` bumps for
 * every input a pass reads. The mutators below stand for the three sources that
 * bump it — a credential write, a provider registration, and a models.json edit
 * — and the coordinator cannot tell them apart, which is the point.
 */
function createRuntime(
	refresh: (options?: ModelsRefreshOptions) => Promise<ModelsRefreshResult>,
	networkEnabled = true,
) {
	let catalogInputsGeneration = 0;
	const bump = () => {
		catalogInputsGeneration += 1;
	};
	return {
		refresh: vi.fn(refresh),
		isNetworkRefreshEnabled: () => networkEnabled,
		getCatalogInputsGeneration: () => catalogInputsGeneration,
		mutateCredentials: bump,
		registerProvider: bump,
		editModelsJson: bump,
	};
}

type CatalogRuntimeStub = ReturnType<typeof createRuntime>;

describe("interactive model catalog refresh", () => {
	it("shares one runtime refresh between concurrent callers", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const runtime = createRuntime(() => deferred.promise);
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
		const runtime = createRuntime((options?: ModelsRefreshOptions) => {
			refreshSignal = options?.signal;
			return deferred.promise;
		});
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

	it("starts new work for a caller that retries in the aborting tick", async () => {
		const refreshSignals: AbortSignal[] = [];
		const runtime = createRuntime((options?: ModelsRefreshOptions) => {
			if (options?.signal) refreshSignals.push(options.signal);
			return new Promise<ModelsRefreshResult>(() => {});
		});
		const firstController = new AbortController();
		const first = refreshModelCatalogs(runtime, { signal: firstController.signal });

		firstController.abort();
		// Synchronous: a closing selector cancels the network work it started
		// before the next render, exactly as a direct runtime.refresh() did.
		expect(refreshSignals[0]?.aborted).toBe(true);

		// Same tick, before the abandoned entry's own cleanup microtask runs. A
		// reopened selector must start a refresh rather than join a dead one.
		const secondController = new AbortController();
		const second = refreshModelCatalogs(runtime, { signal: secondController.signal });
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		expect(refreshSignals[1]?.aborted).toBe(false);

		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		secondController.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
	});

	it("aborts an abandoned refresh in the aborting tick and allows a later refresh to start", async () => {
		const refreshSignals: AbortSignal[] = [];
		const runtime = createRuntime((options?: ModelsRefreshOptions) => {
			if (options?.signal) refreshSignals.push(options.signal);
			return new Promise<ModelsRefreshResult>(() => {});
		});
		const firstController = new AbortController();
		const first = refreshModelCatalogs(runtime, { signal: firstController.signal });

		firstController.abort();
		expect(refreshSignals[0]?.aborted).toBe(true);
		await expect(first).rejects.toMatchObject({ name: "AbortError" });

		const secondController = new AbortController();
		const second = refreshModelCatalogs(runtime, { signal: secondController.signal });
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		secondController.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
	});

	it("refuses to answer a post-credential-change request with a pass that predates it", async () => {
		const beforeLoginPass = createDeferred<ModelsRefreshResult>();
		const afterLoginPass = createDeferred<ModelsRefreshResult>();
		let starts = 0;
		const runtime = createRuntime(() => (starts++ === 0 ? beforeLoginPass.promise : afterLoginPass.promise));
		const controller = new AbortController();

		// The pre-login pass is still in flight when the credential lands, which is
		// exactly what Atomic's API-key login produces: it skips its own refresh and
		// leaves the catalog to the selector that opens next.
		const beforeLogin = refreshModelCatalogs(runtime, { signal: controller.signal });
		runtime.mutateCredentials();
		const afterLogin = refreshModelCatalogs(runtime, { signal: controller.signal });

		expect(runtime.refresh).toHaveBeenCalledTimes(2);

		// The abandoned pre-login waiter still gets the answer it asked for.
		beforeLoginPass.resolve(successfulRefresh());
		afterLoginPass.resolve(successfulRefresh());
		await expect(beforeLogin).resolves.toEqual(successfulRefresh());
		await expect(afterLogin).resolves.toEqual(successfulRefresh());
	});

	it.each([
		["a credential write", (runtime: CatalogRuntimeStub) => runtime.mutateCredentials()],
		["a provider registration", (runtime: CatalogRuntimeStub) => runtime.registerProvider()],
		["a models.json edit", (runtime: CatalogRuntimeStub) => runtime.editModelsJson()],
	])("refuses to answer a request made after %s with a pass that predates it", async (_label, mutate) => {
		const beforeChange = createDeferred<ModelsRefreshResult>();
		const afterChange = createDeferred<ModelsRefreshResult>();
		let starts = 0;
		const runtime = createRuntime(() => (starts++ === 0 ? beforeChange.promise : afterChange.promise));
		const controller = new AbortController();

		// One counter covers all three, so the coordinator needs no case analysis
		// and cannot be left blind to the next input someone adds.
		const first = refreshModelCatalogs(runtime, { signal: controller.signal });
		mutate(runtime);
		const second = refreshModelCatalogs(runtime, { signal: controller.signal });

		expect(runtime.refresh).toHaveBeenCalledTimes(2);

		beforeChange.resolve(successfulRefresh());
		afterChange.resolve(successfulRefresh());
		await expect(first).resolves.toEqual(successfulRefresh());
		await expect(second).resolves.toEqual(successfulRefresh());
	});

	it("still shares one pass while the catalog inputs hold still", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const runtime = createRuntime(() => deferred.promise);
		const controller = new AbortController();

		const first = refreshModelCatalogs(runtime, { signal: controller.signal });
		const second = refreshModelCatalogs(runtime, { signal: controller.signal });
		const third = refreshModelCatalogs(runtime, { signal: controller.signal });
		expect(runtime.refresh).toHaveBeenCalledOnce();

		// Only a change bumps the generation, so the startup pass a selector opens
		// against still answers it — the dedupe this coordinator exists for.
		deferred.resolve(successfulRefresh());
		await Promise.all([first, second, third]);
	});

	it("refuses to answer a different catalog request with an in-flight one", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const requested: Array<boolean | undefined> = [];
		const runtime = createRuntime((options?: ModelsRefreshOptions) => {
			requested.push(options?.allowNetwork);
			return deferred.promise;
		});
		const controller = new AbortController();

		const networked = refreshModelCatalogs(runtime, { allowNetwork: true, signal: controller.signal });
		const cached = refreshModelCatalogs(runtime, { allowNetwork: false, signal: controller.signal });

		expect(runtime.refresh).toHaveBeenCalledTimes(2);
		expect(requested).toEqual([true, false]);

		deferred.resolve(successfulRefresh());
		await Promise.all([networked, cached]);
	});

	it("joins the pass matching the policy an omitted allowNetwork resolves to", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const online = createRuntime(() => deferred.promise, true);
		const offline = createRuntime(() => deferred.promise, false);
		const controller = new AbortController();

		// Startup spells the policy out; the /model selector omits it. On an online
		// runtime both mean the same pass, so the second must not start work.
		const onlineNetworked = refreshModelCatalogs(online, { allowNetwork: true, signal: controller.signal });
		const onlineDefault = refreshModelCatalogs(online, { signal: controller.signal });
		expect(online.refresh).toHaveBeenCalledOnce();

		// The same omitted request on a cache-only runtime resolves to `false`, so it
		// joins the cached pass and leaves an explicit network request its own.
		const offlineCached = refreshModelCatalogs(offline, { allowNetwork: false, signal: controller.signal });
		const offlineDefault = refreshModelCatalogs(offline, { signal: controller.signal });
		expect(offline.refresh).toHaveBeenCalledOnce();
		const offlineNetworked = refreshModelCatalogs(offline, { allowNetwork: true, signal: controller.signal });
		expect(offline.refresh).toHaveBeenCalledTimes(2);

		deferred.resolve(successfulRefresh());
		await Promise.all([onlineNetworked, onlineDefault, offlineCached, offlineDefault, offlineNetworked]);
	});

	it("shares nothing across separate runtimes", async () => {
		const deferred = createDeferred<ModelsRefreshResult>();
		const first = createRuntime(() => deferred.promise);
		const second = createRuntime(() => deferred.promise);
		const controller = new AbortController();

		const firstRefresh = refreshModelCatalogs(first, { signal: controller.signal });
		const secondRefresh = refreshModelCatalogs(second, { signal: controller.signal });

		expect(first.refresh).toHaveBeenCalledOnce();
		expect(second.refresh).toHaveBeenCalledOnce();

		deferred.resolve(successfulRefresh());
		await Promise.all([firstRefresh, secondRefresh]);
	});

	it("rejects a caller whose signal already aborted without starting work", async () => {
		const runtime = createRuntime(() => Promise.resolve(successfulRefresh()));
		const controller = new AbortController();
		controller.abort();

		expect(() => refreshModelCatalogs(runtime, { signal: controller.signal })).toThrow();
		expect(runtime.refresh).not.toHaveBeenCalled();
	});

	it("starts a fresh refresh once the shared one has settled", async () => {
		const first = createDeferred<ModelsRefreshResult>();
		const second = createDeferred<ModelsRefreshResult>();
		const deferrals = [first, second];
		const runtime = createRuntime(() => (deferrals.shift() ?? first).promise);
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
