import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { deriveCursorCredentialScope } from "./catalog-cache.js";
import { CURSOR_API, CURSOR_PROVIDER_ID } from "./config.js";
import type { CursorModelCatalog } from "./model-mapper.js";

export interface CursorAuthorizedRoute {
	readonly modelId: string;
	readonly maxMode: boolean;
	readonly supportsImages: boolean;
	/** Opaque identity shared only by routes from one published authority lease. */
	readonly authorityLease: symbol;
	readonly authoritySignal: AbortSignal;
	readonly credentialScope: string;
	readonly catalogGeneration: number;
	/** Synchronously rejects when this lease is no longer the current TTL-valid authority. */
	assertCurrent(): void;
}
export type CursorExecutionRouteAuthorizer = (
	model: Model<Api>,
	accessToken: string,
	signal?: AbortSignal,
) => Promise<CursorAuthorizedRoute>;

interface CursorExecutionAuthorityRoute {
	readonly modelId: string;
	readonly maxMode: boolean;
	readonly supportsImages: boolean;
}

export interface CursorExecutionAuthorityTimer {
	cancel(): void;
	unref?(): void;
}

export interface CursorExecutionAuthorityScheduler {
	schedule(callback: () => void, delayMs: number): CursorExecutionAuthorityTimer;
	clear(timer: CursorExecutionAuthorityTimer): void;
}

export interface CursorExecutionAuthorityExpiry {
	readonly credentialScope: string;
	readonly generation: number;
}

export interface CursorExecutionAuthorityOptions {
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly scheduler?: CursorExecutionAuthorityScheduler;
	readonly onExpire?: (expiry: CursorExecutionAuthorityExpiry) => void;
}

const DEFAULT_AUTHORITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_AUTHORITY_SCHEDULER: CursorExecutionAuthorityScheduler = {
	schedule(callback, delayMs) {
		const handle = setTimeout(callback, delayMs);
		return {
			cancel: () => clearTimeout(handle),
			unref: () => handle.unref?.(),
		};
	},
	clear(timer) {
		timer.cancel();
	},
};

interface CursorExecutionAuthoritySnapshot {
	readonly credentialScope: string;
	readonly generation: number;
	readonly fetchedAt: number;
	readonly expiresAt: number;
	readonly lease: symbol;
	readonly controller: AbortController;
	readonly routes: ReadonlyMap<string, CursorExecutionAuthorityRoute>;
	expiryTimer?: CursorExecutionAuthorityTimer;
}

export interface CursorExecutionAuthorityRuntime {
	isActive(): boolean;
	activeCredentialScope(): string | undefined;
	now(): number;
	readonly ttlMs: number;
	discover(accessToken: string): Promise<boolean> | undefined;
	activateCurrentCredential?(accessToken: string, credentialScope: string, signal?: AbortSignal): Promise<boolean>;
}

export class CursorExecutionAuthority {
	#snapshot: CursorExecutionAuthoritySnapshot | undefined;
	readonly #closeController = new AbortController();
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #scheduler: CursorExecutionAuthorityScheduler;
	readonly #onExpire: ((expiry: CursorExecutionAuthorityExpiry) => void) | undefined;
	#closed = false;

	constructor(options: CursorExecutionAuthorityOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? DEFAULT_AUTHORITY_TTL_MS;
		this.#scheduler = options.scheduler ?? DEFAULT_AUTHORITY_SCHEDULER;
		this.#onExpire = options.onExpire;
	}

	publish(catalog: CursorModelCatalog, credentialScope: string, generation: number): void {
		if (this.#closed) return;
		this.invalidateSnapshot(new Error("Cursor model catalog authority changed; retry with the current exact route."));
		const routes = new Map<string, CursorExecutionAuthorityRoute>();
		for (const model of catalog.models) {
			if (model.id.trim().length === 0) continue;
			routes.set(model.id, {
				modelId: model.id,
				maxMode: model.maxMode === true,
				supportsImages: model.supportsImages === true,
			});
		}
		const snapshot: CursorExecutionAuthoritySnapshot = {
			credentialScope,
			generation,
			fetchedAt: catalog.fetchedAt,
			expiresAt: catalog.fetchedAt + this.#ttlMs,
			lease: Symbol("cursor-execution-authority"),
			controller: new AbortController(),
			routes,
		};
		this.#snapshot = snapshot;
		this.scheduleExpiry(snapshot);
	}

	async authorize(
		model: Model<Api>,
		accessToken: string,
		signal: AbortSignal | undefined,
		runtime: CursorExecutionAuthorityRuntime,
	): Promise<CursorAuthorizedRoute> {
		if (!runtime.isActive() || this.#closed) throw disposedError();
		if (model.provider.toLowerCase() !== CURSOR_PROVIDER_ID || model.api !== CURSOR_API) {
			throw new Error(`Cursor model ${model.id} is not an exact Cursor provider route.`);
		}
		const credentialScope = deriveCursorCredentialScope(accessToken);
		if (!credentialScope) throw new Error("Cursor execution requires authenticated account-scoped credentials. Run /login again.");
		let activeScope = runtime.activeCredentialScope();
		if (runtime.activateCurrentCredential) {
			const activated = await runtime.activateCurrentCredential(accessToken, credentialScope, signal);
			if (!activated) {
				throw new Error("Cursor credentials do not match the host-selected account. Refresh and reselect a model.");
			}
			activeScope = runtime.activeCredentialScope();
		} else if (!activeScope || activeScope !== credentialScope) {
			throw new Error("Cursor credentials belong to a different account than the host-selected model catalog. Refresh and reselect a model.");
		}
		if (activeScope !== credentialScope) {
			throw new Error("Cursor host credentials changed before the selected account catalog became active. Refresh and reselect a model.");
		}
		let route = this.resolve(credentialScope, model.id, runtime);
		if (route) return route;
		const task = runtime.discover(accessToken);
		if (task) await waitForDiscovery(task, signal, this.#closeController.signal);
		if (!runtime.isActive() || this.#closed) throw disposedError();
		route = this.resolve(credentialScope, model.id, runtime);
		if (!route) throw new Error(`Cursor model ${model.id} is not an exact route in the current authenticated catalog. Refresh and reselect a model.`);
		return route;
	}

	revoke(): void {
		this.invalidateSnapshot(new Error("Cursor model catalog authority was revoked; refresh and reselect a model."));
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const error = disposedError();
		this.invalidateSnapshot(error);
		this.#closeController.abort(error);
	}

	private resolve(scope: string, modelId: string, runtime: CursorExecutionAuthorityRuntime): CursorAuthorizedRoute | undefined {
		const snapshot = this.#snapshot;
		if (!snapshot || snapshot.credentialScope !== scope) return undefined;
		const route = snapshot.routes.get(modelId);
		if (!route) return undefined;
		const authorization: CursorAuthorizedRoute = {
			...route,
			authorityLease: snapshot.lease,
			authoritySignal: snapshot.controller.signal,
			credentialScope: snapshot.credentialScope,
			catalogGeneration: snapshot.generation,
			assertCurrent: () => this.assertCurrent(snapshot, modelId, runtime),
		};
		authorization.assertCurrent();
		return authorization;
	}

	private assertCurrent(snapshot: CursorExecutionAuthoritySnapshot, modelId: string, runtime: CursorExecutionAuthorityRuntime): void {
		if (this.#closed || !runtime.isActive()) throw disposedError();
		if (runtime.activeCredentialScope() !== snapshot.credentialScope) {
			throw new Error("Cursor credentials no longer match the active model catalog. Refresh and reselect a model.");
		}
		if (this.#snapshot !== snapshot || snapshot.controller.signal.aborted) {
			throw new Error("Cursor model catalog authority changed; retry with the current exact route.");
		}
		const currentTime = this.#now();
		if (currentTime < snapshot.fetchedAt || currentTime >= snapshot.expiresAt || !snapshot.routes.has(modelId)) {
			throw new Error(`Cursor model ${modelId} is not an exact TTL-valid route in the current authenticated catalog. Refresh and reselect a model.`);
		}
	}

	private scheduleExpiry(snapshot: CursorExecutionAuthoritySnapshot): void {
		const delayMs = Math.max(0, snapshot.expiresAt - this.#now());
		const expiryTimer = this.#scheduler.schedule(() => {
			if (this.#snapshot !== snapshot) return;
			snapshot.expiryTimer = undefined;
			if (this.#now() < snapshot.expiresAt) {
				this.scheduleExpiry(snapshot);
				return;
			}
			const expiry = { credentialScope: snapshot.credentialScope, generation: snapshot.generation };
			this.invalidateSnapshot(new Error("Cursor model catalog authority expired; refresh and reselect a model."));
			this.#onExpire?.(expiry);
		}, delayMs);
		expiryTimer.unref?.();
		snapshot.expiryTimer = expiryTimer;
	}

	private invalidateSnapshot(reason: Error): void {
		const snapshot = this.#snapshot;
		this.#snapshot = undefined;
		if (!snapshot) return;
		if (snapshot.expiryTimer) {
			this.#scheduler.clear(snapshot.expiryTimer);
			snapshot.expiryTimer = undefined;
		}
		if (!snapshot.controller.signal.aborted) snapshot.controller.abort(reason);
	}
}

function disposedError(): Error {
	return new Error("Cursor provider is disposed; refresh the catalog in an active session.");
}

async function waitForDiscovery(task: Promise<boolean>, callerSignal: AbortSignal | undefined, closeSignal: AbortSignal): Promise<void> {
	if (callerSignal?.aborted) throw abortReason(callerSignal);
	if (closeSignal.aborted) throw abortReason(closeSignal);
	const signals = callerSignal ? [callerSignal, closeSignal] : [closeSignal];
	const cleanups: Array<() => void> = [];
	try {
		await Promise.race([
			task.then(() => undefined),
			...signals.map((signal) => new Promise<never>((_resolve, reject) => {
				const onAbort = (): void => reject(abortReason(signal));
				signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onAbort));
			})),
		]);
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Cursor request aborted.");
}
