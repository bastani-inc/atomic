import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Credential, ModelsStore, ModelsStoreEntry, Provider, RefreshModelsContext } from "@bastani/atomic-ai";
import { raceWithAbortSignal } from "../utils/abort.js";

type AccountRow = ModelsStoreEntry & { accountListKey?: string; accountListReadId?: string };
type Store = string | ModelsStore;
function modelListKey(provider: string, credential?: Credential): string | undefined {
	if (!credential) return undefined;
	const secret = credential.type === "oauth" ? credential.access : credential.key;
	return secret ? `${provider}:${credential.type}:${createHash("sha256").update(secret).digest("hex")}` : undefined;
}

interface Flight<T> {
	controller: AbortController;
	promise: Promise<T>;
	waiters: number;
}
function join<T>(flight: Flight<T>, signal: AbortSignal): Promise<T> {
	flight.waiters++;
	return raceWithAbortSignal(flight.promise, signal).finally(() => {
		if (--flight.waiters === 0 && signal.aborted) flight.controller.abort();
	});
}
// Only outstanding requests, never completed catalogs. The last completion removes the store itself.
const flights = new Map<Store, Map<string, Flight<AccountRow | undefined>>>();
interface Discovery {
	store: Store;
	provider: string;
	controller: AbortController;
	signal: AbortSignal;
	answered: boolean;
	// While other runtimes need the owner's provider publication, keep its refresh alive even if its own caller leaves.
	ownsFlight?: boolean;
}
const discovery = new AsyncLocalStorage<Discovery>();

/** Observations come from the normal provider cache restore, not an additional store or credential lookup. */
export class AccountModelLists {
	private readonly cache = new Map<string, "missing" | "legacy" | "account" | "unreadable">();
	private readonly probes = new Map<string, Promise<void>>();
	private readonly fresh = new Map<string, string>();
	private readonly attempted = new Set<string>();
	private readonly local = new Map<string, Flight<void>>();
	private readonly store: ModelsStore;
	constructor(store: ModelsStore) {
		this.store = store;
	}

	/** When initial restoration was skipped, inspect presence once without applying a row or resolving auth. */
	async probeIfUnobserved(provider: string, signal: AbortSignal): Promise<void> {
		if (this.cache.has(provider)) return;
		let probe = this.probes.get(provider);
		if (!probe) {
			probe = raceWithAbortSignal(
				Promise.resolve().then(() => {
					signal.throwIfAborted();
					return this.store.read(provider, { signal });
				}),
				signal,
			)
				.then(
					(row: AccountRow | undefined) => {
						if (!this.cache.has(provider))
							this.cache.set(provider, row ? (row.accountListKey ? "account" : "legacy") : "missing");
					},
					() => {
						if (!this.cache.has(provider)) this.cache.set(provider, "unreadable");
					},
				)
				.finally(() => this.probes.delete(provider));
			this.probes.set(provider, probe);
		}
		await raceWithAbortSignal(probe, signal);
	}
	needsRead(provider: string): boolean {
		return !this.attempted.has(provider) && (this.cache.get(provider) ?? "missing") === "missing";
	}
	invalidate(provider: string): void {
		if (this.cache.get(provider) === "account") this.cache.set(provider, "missing");
		this.attempted.delete(provider);
		this.fresh.delete(provider);
		this.local.get(provider)?.controller.abort();
		this.local.delete(provider);
	}
	clear(): void {
		for (const provider of this.cache.keys()) this.invalidate(provider);
	}
	hasFreshAnswer(provider: string): boolean {
		return this.fresh.has(provider);
	}
	answered(provider: string): void {
		const scope = discovery.getStore();
		if (scope?.provider === provider) scope.answered = true;
	}

	observe(provider: Provider, indirectKey: () => Credential | undefined): Provider {
		const refresh = provider.refreshModels;
		if (!refresh || provider.refreshModelsAuth !== "credential") return provider;
		return {
			...provider,
			refreshModels: (context) => {
				const id = provider.id;
				let stored: AccountRow | undefined = context.stored;
				if (stored?.accountListKey) {
					const key = modelListKey(id, context.credential ?? indirectKey());
					// With an opaque key command use the cached row just as an ordinary restore does, but do not
					// attribute it to this account. Never execute a command to identify a cached list.
					if (!key) this.fresh.delete(id);
					else if (key !== stored.accountListKey) stored = undefined;
				}
				if (!context.signal.aborted) {
					if (!stored && this.cache.get(id) === "account") this.attempted.delete(id);
					this.cache.set(id, stored ? (stored.accountListKey ? "account" : "legacy") : "missing");
					if (this.fresh.get(id) !== stored?.accountListReadId) this.fresh.delete(id);
				}
				const scope = discovery.getStore();
				if (!context.allowNetwork || scope?.provider !== id) {
					if (context.allowNetwork) {
						this.fresh.delete(id);
						if (!stored)
							return refresh({
								...context,
								stored,
								publish: async (publication) => {
									const published = await context.publish(publication);
									if (published && publication.persist) this.cache.set(id, "legacy");
									return published;
								},
							});
					}
					return refresh(stored === context.stored ? context : { ...context, stored });
				}
				if (stored) return refresh({ ...context, stored, allowNetwork: false });
				// Use the credential and route resolved by the normal refresh, including OAuth renewal and extensions.
				const key = modelListKey(id, context.credential);
				return key ? this.share(scope, key, { ...context, stored }, refresh) : Promise.resolve();
			},
		};
	}

	private async share(
		scope: Discovery,
		key: string,
		context: RefreshModelsContext,
		refresh: NonNullable<Provider["refreshModels"]>,
	): Promise<void> {
		scope.signal.throwIfAborted();
		const identity = JSON.stringify([key, context.baseUrl]);
		const reads = flights.get(scope.store) ?? new Map<string, Flight<AccountRow | undefined>>();
		const peer = reads.get(identity);
		if (peer && !peer.controller.signal.aborted) {
			const row = await join(peer, scope.signal);
			context.signal.throwIfAborted();
			await refresh({ ...context, stored: row, allowNetwork: false });
			if (row) this.cache.set(scope.provider, "account");
			if (row?.accountListReadId) this.fresh.set(scope.provider, row.accountListReadId);
			return;
		}
		scope.ownsFlight = true;
		const flight = {
			controller: scope.controller,
			promise: raceWithAbortSignal(this.publish(scope, key, context, refresh), context.signal),
			waiters: 0,
		};
		flights.set(scope.store, reads);
		reads.set(identity, flight);
		flight.promise = flight.promise.finally(() => {
			if (reads.get(identity) === flight) reads.delete(identity);
			if (!reads.size && flights.get(scope.store) === reads) flights.delete(scope.store);
		});
		// The owner's refresh (and its generation-checked publish) outlives that caller only while peers wait.
		void join(flight, scope.signal).catch(() => undefined);
		await flight.promise;
	}

	private async publish(
		scope: Discovery,
		key: string,
		context: RefreshModelsContext,
		refresh: NonNullable<Provider["refreshModels"]>,
	): Promise<AccountRow | undefined> {
		// A completed flight is not retained. If its final write beat our claim but not the cache read in
		// the refresh context, restore that write rather than issuing another account request.
		const latest: AccountRow | undefined = await this.store.read(scope.provider, { signal: context.signal });
		context.signal.throwIfAborted();
		if (latest && (!latest.accountListKey || latest.accountListKey === key)) {
			await refresh({ ...context, stored: latest, allowNetwork: false });
			this.cache.set(scope.provider, latest.accountListKey ? "account" : "legacy");
			return latest;
		}
		let row: AccountRow | undefined;
		let catalogOnly = false;
		const publish: RefreshModelsContext["publish"] = async (publication) => {
			if (!publication.persist) return context.publish(publication);
			row = {
				...publication.persist,
				accountListKey: key,
				...(scope.answered ? { accountListReadId: randomUUID() } : {}),
			};
			// Copilot stages the public catalog before adding the account's models. Publish the complete row once,
			// so a second session cannot treat its intermediate write as a completed account list.
			catalogOnly = scope.provider === "github-copilot" && !scope.answered;
			return context.publish(catalogOnly ? { update: publication.update } : { ...publication, persist: row });
		};
		try {
			await refresh({ ...context, publish });
		} finally {
			if (catalogOnly && row && !context.signal.aborted) await context.publish({ persist: row });
		}
		context.signal.throwIfAborted();
		if (row) this.cache.set(scope.provider, "account");
		if (row?.accountListReadId) this.fresh.set(scope.provider, row.accountListReadId);
		return row;
	}

	/** One local provider refresh; different runtimes share only inside its resolved account's network phase. */
	read(
		store: Store,
		provider: string,
		signal: AbortSignal,
		timeoutMs: number,
		refresh: (signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		signal.throwIfAborted();
		const current = this.local.get(provider);
		if (current && !current.controller.signal.aborted) return join(current, signal);
		const caller = new AbortController();
		const scope: Discovery = {
			store,
			provider,
			controller: new AbortController(),
			signal: caller.signal,
			answered: false,
		};
		caller.signal.addEventListener(
			"abort",
			() => {
				if (!scope.ownsFlight) scope.controller.abort();
			},
			{ once: true },
		);
		const flight = {
			controller: caller,
			waiters: 0,
			promise: discovery.run(scope, () =>
				refresh(AbortSignal.any([scope.controller.signal, AbortSignal.timeout(timeoutMs)])),
			),
		};
		this.local.set(provider, flight);
		flight.promise = flight.promise
			.then(() => {
				if (this.local.get(provider) === flight) this.attempted.add(provider);
			})
			.finally(() => {
				if (this.local.get(provider) === flight) this.local.delete(provider);
			});
		return join(flight, signal);
	}
}
