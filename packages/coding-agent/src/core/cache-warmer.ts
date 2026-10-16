import { type Api, calculateCost, type Model, type TranscriptContext, type Usage } from "@bastani/pi-ai";
import type { SimpleStreamOptions } from "@bastani/pi-ai/compat";
import { getProviderEnvValue } from "@bastani/pi-ai/utils/provider-env";
import { getDefaultCacheRetention } from "./cache-retention.ts";
import type { ModelRuntime } from "./model-runtime.js";
import type { ModelRuntimeSimpleStreamOptions } from "./model-runtime-streaming.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

const MAX_WARMING_AGE_MS = 60 * 60_000;
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
const IDLE_CONTINUATION_PROBABILITY = 0.15;

export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const configured = getProviderEnvValue("PI_CACHE_RETENTION", options?.env);
	const retention =
		options?.cacheRetention ??
		(configured === "none"
			? "none"
			: configured === "short"
				? "short"
				: configured === "long"
					? "long"
					: getDefaultCacheRetention(model));
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/** Budget-based Anthropic thinking changes the cache key when max_tokens changes. */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	return calculateCost(model, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	}).total;
}

export type CacheWarmingAction = "warm" | "stop";
export interface CacheWarmingDecision {
	phase: "streaming" | "idle";
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	expectedSavings: number;
	economicsAvailable: boolean;
	action: CacheWarmingAction;
}
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}
export interface CacheWarmingDecisionEventResult {
	action?: CacheWarmingAction;
}
export interface CacheWarmingStatus {
	state: "inactive" | "scheduled" | "refreshing";
	reason?: string;
	nextWarmAt?: number;
	decision?: CacheWarmingDecision;
	extensionOverride?: boolean;
}
export interface CacheWarmRequest {
	model: Model<Api>;
	context: TranscriptContext;
	options: ModelRuntimeSimpleStreamOptions;
}
interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	refreshDeadlineAt: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** One replayable prompt, bounded by its original start time rather than refresh activity. */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus = { state: "inactive", reason: "waiting for first request" };
	onWarmed?: (entry: UsageEntry) => void;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	private readonly runRefresh: (refresh: () => Promise<void>) => Promise<void>;
	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
		runRefresh: (refresh: () => Promise<void>) => Promise<void> = (refresh) => refresh(),
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.runRefresh = runRefresh;
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing)
			return { state: "inactive", reason: "cache economics unavailable" };
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.clearRun();
		if (this.getMode() === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		this.run = {
			...request,
			isCurrent,
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run);
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) this.stop("30-minute idle safety limit reached");
	}
	onModeChanged(): void {
		if (!this.run) return;
		const reason = this.getModeStopReason(this.run);
		if (reason) this.stop(reason);
	}
	cancel(): void {
		this.stop("inactive");
	}
	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}
	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}
	private schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = Date.now() + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(
			() => {
				void this.runRefresh(() => this.refresh(run)).catch(() => {
					if (this.run === run) this.stop("inactive");
				});
			},
			Math.max(0, run.nextWarmAt - Date.now()),
		);
		run.timer.unref?.();
	}
	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		const decision = this.evaluate(run);
		const { warmCost, missCost, continuationProbability } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				continuationProbability,
				action,
			});
		} catch {
			/* Extension failure retains the default decision. */
		}
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			this.stop(
				extensionOverride
					? "stopped by extension"
					: decision.economicsAvailable
						? "expected savings below threshold"
						: "cache economics unavailable",
				{ decision, extensionOverride },
			);
			return;
		}
		run.extensionOverride = extensionOverride;
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, {
					...run.options,
					maxTokens: 1,
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				const entry = await this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
				);
				this.onWarmed?.(entry);
			}
		} catch {
			/* Best-effort replay must not fail the real agent run. */
		}
		if (this.run === run) this.schedule(run);
	}
	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}
	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}
	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}
	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}
function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${decision.action === "warm" ? ">=" : "<"} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride))
		return `Inactive (${status.reason ?? "unknown reason"})`;
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	let seconds = Math.max(0, Math.ceil(((status.nextWarmAt ?? now) - now) / 1000));
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	const parts = [
		...(hours > 0 ? [`${hours}h`] : []),
		...(minutes > 0 ? [`${minutes}m`] : []),
		...(seconds > 0 ? [`${seconds}s`] : []),
	];
	return `${parts.length ? `Decision in ${parts.join(" ")}` : "Decision now"} (${details})`;
}
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	return `Cache warmed${entry.note ? ` (${entry.note})` : ""}: $${entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1")}`;
}
