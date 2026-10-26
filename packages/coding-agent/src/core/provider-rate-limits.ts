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

interface ProviderLimitState {
	readonly providers: Map<string, ProviderLimit>;
	readonly observedFailures: WeakSet<object>;
}

const stateKey = Symbol.for("atomic-coding-agent/provider-rate-limits@1");
const globals = globalThis as typeof globalThis & { [stateKey]?: ProviderLimitState };
const state = globals[stateKey] ?? {
	providers: new Map<string, ProviderLimit>(),
	observedFailures: new WeakSet<object>(),
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

export function markProviderRateLimitObserved(error: object): void {
	state.observedFailures.add(error);
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
		if (state.observedFailures.delete(value)) return remaining();
	}
	const providerEntry = providerLimit(provider);
	const limit =
		model !== undefined && failureNamesModel(error, model)
			? providerLimit(modelLimitKey(provider, model))
			: providerEntry;
	providerEntry.rateLimitCount += 1;
	limit.consecutiveLimits += 1;
	const backoff = Math.min(60_000, 1000 * 2 ** Math.min(limit.consecutiveLimits - 1, 6));
	const delay = providerRetryHint(error).retryAfterMs ?? backoff * (0.5 + Math.random() * 0.5);
	const until = Math.ceil(Date.now() + Math.max(1, delay));
	if (kind === "quota_exhausted") limit.unavailableUntil = Math.max(limit.unavailableUntil, until);
	else limit.cooldownUntil = Math.max(limit.cooldownUntil, until);
	return remaining();
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
