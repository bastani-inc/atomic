import { getProviderRetryAfterMs } from "@bastani/pi-ai/utils/retry-hints";
import { normalizeModelFailureSignal } from "./model-fallback-failures.js";

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

function providerLimit(provider: string): ProviderLimit {
	let limit = state.providers.get(provider);
	if (!limit) {
		limit = { cooldownUntil: 0, rateLimitCount: 0, consecutiveLimits: 0, requests: [] };
		state.providers.set(provider, limit);
	}
	return limit;
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

export function providerCooldownMs(provider: string | undefined): number {
	return provider === undefined ? 0 : Math.max(0, (state.providers.get(provider)?.cooldownUntil ?? 0) - Date.now());
}

export function providerAdmissionDelayMs(provider: string): number {
	const limit = state.providers.get(provider);
	if (!limit) return 0;
	const now = Date.now();
	const cooldown = Math.max(0, limit.cooldownUntil - now);
	if (!limit.budget) return cooldown;
	limit.requests = limit.requests.filter((timestamp) => timestamp > now - limit.budget!.intervalMs);
	const budgetDelay =
		limit.requests.length < limit.budget.maxRequests
			? 0
			: limit.requests[limit.requests.length - limit.budget.maxRequests]! + limit.budget.intervalMs - now;
	return Math.max(cooldown, budgetDelay);
}

export function tryAdmitProviderRequest(provider: string): number {
	const delay = providerAdmissionDelayMs(provider);
	if (delay === 0) {
		const limit = state.providers.get(provider);
		if (limit?.budget) limit.requests.push(Date.now());
	}
	return delay;
}

export function isProviderRateLimit(error: unknown): boolean {
	return normalizeModelFailureSignal(error)?.kind === "rate_limit";
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

export function recordProviderRateLimit(provider: string | undefined, error: unknown): number | undefined {
	if (provider === undefined || !isProviderRateLimit(error)) return undefined;
	for (const value of failureObjects(error)) {
		if (state.observedFailures.delete(value)) return providerCooldownMs(provider);
	}
	const limit = providerLimit(provider);
	limit.rateLimitCount += 1;
	limit.consecutiveLimits += 1;
	const backoff = Math.min(60_000, 1000 * 2 ** Math.min(limit.consecutiveLimits - 1, 6));
	const delay = providerRetryHint(error).retryAfterMs ?? backoff * (0.5 + Math.random() * 0.5);
	limit.cooldownUntil = Math.max(limit.cooldownUntil, Date.now() + Math.max(1, delay));
	return providerCooldownMs(provider);
}

export function recordProviderSuccess(provider: string): void {
	const limit = state.providers.get(provider);
	if (limit) limit.consecutiveLimits = 0;
}

export function providerRetryHint(error: unknown): { retryAfterMs?: number } {
	for (const value of failureObjects(error)) {
		const retryAfterMs = getProviderRetryAfterMs(value);
		if (retryAfterMs !== undefined) return { retryAfterMs };
	}
	return {};
}
