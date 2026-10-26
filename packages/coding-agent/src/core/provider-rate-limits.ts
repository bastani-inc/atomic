import { getProviderRetryAfterMs } from "@bastani/pi-ai/utils/retry-hints";
import { errorMessage, normalizeModelFailureSignal } from "./model-fallback-failures.ts";

export interface ProviderRequestBudget {
	readonly maxRequests: number;
	readonly intervalMs: number;
}

export interface ProviderRateLimitSnapshot {
	readonly provider: string;
	readonly rateLimitCount: number;
	readonly cooldownUntil: number;
}

interface ProviderLimit {
	cooldownUntil: number;
	/** Quota exhaustion: the walk skips this account until then, but requests are not held back. */
	unavailableUntil: number;
	rateLimitCount: number;
	consecutiveLimits: number;
	budget?: ProviderRequestBudget;
	requests: number[];
}

/** The limit a failure was recorded against: the whole provider or one of its models. */
export interface ProviderLimitScope {
	readonly key: string;
}

interface ProviderLimitState {
	readonly providers: Map<string, ProviderLimit>;
	/** Failures already recorded, with the limit (provider or model) they were recorded against. */
	readonly observedFailures: WeakMap<object, ProviderLimitScope>;
	/** Listeners told when this process records or extends a limit; absent on state created by an older copy. */
	observers?: Set<(observation: ProviderRateLimitObservation) => void>;
}

/**
 * A limit one process recorded, in a form other processes on the same host can apply: the provider, the
 * model when the limit covers only that model, and the wall-clock time the limit ends.
 */
export interface ProviderRateLimitObservation {
	readonly provider: string;
	readonly model?: string;
	/** `cooldown` holds requests back; `unavailable` (an exhausted quota) makes the fallback walk skip the account. */
	readonly kind: "cooldown" | "unavailable";
	readonly untilEpochMs: number;
}

const stateKey = Symbol.for("atomic-coding-agent/provider-rate-limits@1");
const globals = globalThis as typeof globalThis & { [stateKey]?: ProviderLimitState };
const state: ProviderLimitState = globals[stateKey] ?? {
	providers: new Map<string, ProviderLimit>(),
	observedFailures: new WeakMap<object, ProviderLimitScope>(),
};
globals[stateKey] = state;

function providerLimit(key: string): ProviderLimit {
	let limit = state.providers.get(key);
	if (!limit) {
		limit = { cooldownUntil: 0, unavailableUntil: 0, rateLimitCount: 0, consecutiveLimits: 0, requests: [] };
		state.providers.set(key, limit);
	}
	return limit;
}

/** Key for limits scoped to one model; provider IDs never contain "/", so it cannot collide with a provider key. */
function modelLimitKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function scopedLimits(provider: string, model: string | undefined): ProviderLimit[] {
	const limits = [state.providers.get(provider)];
	if (model !== undefined) limits.push(state.providers.get(modelLimitKey(provider, model)));
	return limits.filter((limit): limit is ProviderLimit => limit !== undefined);
}

export function configureProviderRequestBudget(provider: string, budget: ProviderRequestBudget | undefined): void {
	if (!provider.trim()) throw new Error("Provider request budget requires a provider ID");
	if (
		budget &&
		(!Number.isSafeInteger(budget.maxRequests) ||
			budget.maxRequests <= 0 ||
			!Number.isSafeInteger(budget.intervalMs) ||
			budget.intervalMs <= 0)
	) {
		throw new Error("Provider request budget requires positive integer maxRequests and intervalMs");
	}
	const limit = providerLimit(provider);
	limit.budget = budget ? { ...budget } : undefined;
	if (!budget) limit.requests = [];
}

export function providerRateLimitSnapshot(provider: string): ProviderRateLimitSnapshot | undefined {
	const limit = state.providers.get(provider);
	return limit ? { provider, rateLimitCount: limit.rateLimitCount, cooldownUntil: limit.cooldownUntil } : undefined;
}

export function providerIdForModel(model: string | object | undefined): string | undefined {
	if (typeof model === "string") return model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
	if (model && "provider" in model && typeof model.provider === "string") return model.provider;
	return undefined;
}

/** Model ID within its provider, from a `provider/model` reference or a model object. */
export function modelIdForModel(model: string | object | undefined): string | undefined {
	if (typeof model === "string") return model.includes("/") ? model.slice(model.indexOf("/") + 1) : undefined;
	if (model && "id" in model && typeof model.id === "string") return model.id;
	return undefined;
}

/** Time until requests to the provider (and, when given, this model) are admitted again. */
export function providerCooldownMs(provider: string | undefined, model?: string): number {
	if (provider === undefined) return 0;
	const until = Math.max(0, ...scopedLimits(provider, model).map((limit) => limit.cooldownUntil));
	return Math.max(0, until - Date.now());
}

/** Time until an exhausted quota on the provider (and, when given, this model) resets. */
export function providerUnavailableMs(provider: string | undefined, model?: string): number {
	if (provider === undefined) return 0;
	const until = Math.max(0, ...scopedLimits(provider, model).map((limit) => limit.unavailableUntil));
	return Math.max(0, until - Date.now());
}

export function providerAdmissionDelayMs(provider: string, model?: string): number {
	const limit = state.providers.get(provider);
	const now = Date.now();
	const cooldown = providerCooldownMs(provider, model);
	if (!limit?.budget) return cooldown;
	limit.requests = limit.requests.filter((timestamp) => timestamp > now - limit.budget!.intervalMs);
	const budgetDelay =
		limit.requests.length < limit.budget.maxRequests
			? 0
			: limit.requests[limit.requests.length - limit.budget.maxRequests]! + limit.budget.intervalMs - now;
	return Math.max(cooldown, budgetDelay);
}

export function tryAdmitProviderRequest(provider: string, model?: string): number {
	const delay = providerAdmissionDelayMs(provider, model);
	if (delay === 0) {
		const limit = state.providers.get(provider);
		if (limit?.budget) limit.requests.push(Date.now());
	}
	return delay;
}

export function isProviderRateLimit(error: unknown): boolean {
	return normalizeModelFailureSignal(error)?.kind === "rate_limit";
}

/** A rate limit or an exhausted quota: either makes the account unusable until the server's reset. */
export function isProviderLimitFailure(error: unknown): boolean {
	const kind = normalizeModelFailureSignal(error)?.kind;
	return kind === "rate_limit" || kind === "quota_exhausted";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the failure names the model that hit the limit. Providers that limit per model say so in the
 * error ("rate limit reached for <model>"); without that, the limit may cover the whole account.
 */
function failureNamesModel(error: unknown, model: string): boolean {
	if (!model.trim()) return false;
	const text = failureObjects(error)
		.map((value) => errorMessage(value))
		.join("\n");
	return new RegExp(`(?<![\\w.-])${escapeRegExp(model)}(?![\\w-]|\\.\\w)`, "i").test(text);
}

function failureObjects(error: unknown): object[] {
	const seen = new Set<object>();
	let current = error;
	while (current !== null && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		current = "cause" in current ? current.cause : undefined;
	}
	return [...seen];
}

export function markProviderRateLimitObserved(error: object, scope: ProviderLimitScope): void {
	state.observedFailures.set(error, scope);
}

/**
 * Record a rate limit or exhausted quota and return how long the account stays limited. The limit covers
 * only `model` when the failure names that model, and the whole provider otherwise.
 */
export function recordProviderRateLimit(
	provider: string | undefined,
	error: unknown,
	model?: string,
): number | undefined {
	if (provider === undefined) return undefined;
	const kind = normalizeModelFailureSignal(error)?.kind;
	if (kind !== "rate_limit" && kind !== "quota_exhausted") return undefined;
	const remaining = () =>
		kind === "quota_exhausted" ? providerUnavailableMs(provider, model) : providerCooldownMs(provider, model);
	for (const value of failureObjects(error)) {
		const scope = state.observedFailures.get(value);
		if (scope !== undefined) {
			state.observedFailures.delete(value);
			// Already counted; a server hint on this later view of the failure can still extend the limit.
			recordProviderRetryHint(provider, error, scope);
			return remaining();
		}
	}
	const providerEntry = providerLimit(provider);
	const key = providerLimitScope(provider, error, model).key;
	const limit = providerLimit(key);
	providerEntry.rateLimitCount += 1;
	limit.consecutiveLimits += 1;
	const backoff = Math.min(60_000, 1000 * 2 ** Math.min(limit.consecutiveLimits - 1, 6));
	extendLimit(key, kind, providerRetryHint(error).retryAfterMs ?? backoff * (0.5 + Math.random() * 0.5));
	return remaining();
}

/** The limit a failure belongs to: its model when the failure names that model, else the whole provider. */
export function providerLimitScope(provider: string, error: unknown, model?: string): ProviderLimitScope {
	return { key: model !== undefined && failureNamesModel(error, model) ? modelLimitKey(provider, model) : provider };
}

function extendLimit(key: string, kind: "rate_limit" | "quota_exhausted", delay: number): void {
	const until = Math.ceil(Date.now() + Math.max(1, delay));
	const observation = raiseLimit(key, kind === "quota_exhausted" ? "unavailable" : "cooldown", until);
	if (observation === undefined || state.observers === undefined) return;
	for (const observer of state.observers) {
		// An observer must never change how the request that hit the limit is handled, nor starve the others.
		try {
			observer(observation);
		} catch (error) {
			if (!observerFailureReported) {
				observerFailureReported = true;
				console.debug("Provider rate-limit observer failed", error);
			}
		}
	}
}

/** Observer failures are reported once per process. */
let observerFailureReported = false;

/** Raise one limit to `until`; returns the limit as an observation when it grew, and nothing otherwise. */
function raiseLimit(
	key: string,
	kind: ProviderRateLimitObservation["kind"],
	until: number,
): ProviderRateLimitObservation | undefined {
	const limit = providerLimit(key);
	const field = kind === "unavailable" ? "unavailableUntil" : "cooldownUntil";
	if (until <= limit[field]) return undefined;
	limit[field] = until;
	const slash = key.indexOf("/");
	return slash < 0
		? { provider: key, kind, untilEpochMs: until }
		: { provider: key.slice(0, slash), model: key.slice(slash + 1), kind, untilEpochMs: until };
}

/**
 * Merge a limit another process observed. It only ever extends the limit of the same provider or model
 * scope, ignores limits that already ended, and counts no failure here. Returns whether the limit grew.
 * Observers are not told: the observation came from elsewhere, so sending it on would echo it back.
 */
export function applyProviderRateLimitObservation(observation: ProviderRateLimitObservation): boolean {
	const { provider, model, kind, untilEpochMs } = observation;
	if (!provider || provider.includes("/") || (kind !== "cooldown" && kind !== "unavailable")) return false;
	if (!Number.isFinite(untilEpochMs) || untilEpochMs <= Date.now()) return false;
	const key = model === undefined ? provider : modelLimitKey(provider, model);
	return raiseLimit(key, kind, Math.ceil(untilEpochMs)) !== undefined;
}

/** Every limit of this process that has not ended yet, as observations another process can apply. */
export function providerRateLimitObservations(): ProviderRateLimitObservation[] {
	const now = Date.now();
	const observations: ProviderRateLimitObservation[] = [];
	for (const [key, limit] of state.providers) {
		const slash = key.indexOf("/");
		const scope = slash < 0 ? { provider: key } : { provider: key.slice(0, slash), model: key.slice(slash + 1) };
		if (limit.cooldownUntil > now)
			observations.push({ ...scope, kind: "cooldown", untilEpochMs: limit.cooldownUntil });
		if (limit.unavailableUntil > now)
			observations.push({ ...scope, kind: "unavailable", untilEpochMs: limit.unavailableUntil });
	}
	return observations;
}

/**
 * Be told each time this process records or extends a limit, but not when it applies another process's
 * observation. Only rate-limited and quota-exhausted responses notify, never ordinary requests.
 */
export function observeProviderRateLimits(observer: (observation: ProviderRateLimitObservation) => void): () => void {
	state.observers ??= new Set();
	const observers = state.observers;
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}

/**
 * Apply the server retry hint of a failure that was already recorded against `scope`, without counting it
 * again. A limit only ever grows, so a guess made before the hint was known cannot shorten it.
 */
export function recordProviderRetryHint(provider: string | undefined, error: unknown, scope: ProviderLimitScope): void {
	if (provider === undefined) return;
	const kind = normalizeModelFailureSignal(error)?.kind;
	if (kind !== "rate_limit" && kind !== "quota_exhausted") return;
	const retryAfterMs = providerRetryHint(error).retryAfterMs;
	if (retryAfterMs !== undefined) extendLimit(scope.key, kind, retryAfterMs);
}

export function recordProviderSuccess(provider: string, model?: string): void {
	for (const limit of scopedLimits(provider, model)) limit.consecutiveLimits = 0;
}

export function providerRetryHint(error: unknown): { retryAfterMs?: number } {
	for (const value of failureObjects(error)) {
		const retryAfterMs = getProviderRetryAfterMs(value);
		if (retryAfterMs !== undefined) return { retryAfterMs };
	}
	return {};
}
