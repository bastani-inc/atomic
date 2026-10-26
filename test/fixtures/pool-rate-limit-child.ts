import { setTimeout as delay } from "node:timers/promises";
import * as atomic from "@bastani/atomic";
import { AuthStorage, ModelRuntime, providerCooldownMs, providerUnavailableMs, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** One HTTP provider with three models; a test server stands in for it (#4023). */
export const LIMITED_PROVIDER = "pool-limited";
export const LIMITED_MODEL = "limited-model";
export const SPARE_MODEL = "spare-model";
export const QUOTA_MODEL = "quota-model";
/** A provider whose limit the root records before its pool starts any worker. */
export const EARLY_PROVIDER = "pool-early-limited";

/** The fake provider's answer to `GET <baseUrl>/limits-sent`. */
export interface LimitsSentStatus {
	readonly sent429: boolean;
	readonly sent402: boolean;
	/** Set once the first worker's stages ended: their replies, or the error that ended them. */
	readonly firstDone?: string;
}

const spec = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
});

export async function limitedStageOptions(cwd: string, baseUrl: string, model: string, fallbacks: readonly string[] = []) {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(LIMITED_PROVIDER, {
		api: "openai-completions",
		baseUrl,
		apiKey: "fixture",
		models: [LIMITED_MODEL, SPARE_MODEL, QUOTA_MODEL].map(spec),
	});
	return {
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: modelRuntime.getModel(LIMITED_PROVIDER, model)!,
		fallbackModels: fallbacks.map((id) => `${LIMITED_PROVIDER}/${id}`),
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}

/**
 * Role `first` meets the provider's limits: a 429 on one model, then an exhausted quota on another.
 * Role `second` waits until the provider has sent both limits and the quota mark reaches its own
 * process, then asks the quota model with a fallback, the spare model, and the rate-limited model, in
 * that order. Role `early` reports the cooldown of {@link EARLY_PROVIDER} it sees as it starts.
 */
export const child = workflow({
	name: "pool-rate-limit-child",
	description: "Provider limits shared across a local worker pool",
	inputs: { role: Type.String(), baseUrl: Type.String() },
	outputs: {
		sawLimits: Type.Boolean(),
		/** Wall-clock end of the rate-limited model's cooldown the first worker recorded from the 429. */
		limitedUntil: Type.Number(),
		earlyCooldownMs: Type.Number(),
		replies: Type.Array(Type.String()),
	},
	async run(ctx) {
		const cwd = ctx.cwd ?? process.cwd();
		const ask = async (name: string, model: string, fallbacks: readonly string[] = []) => {
			const options = await limitedStageOptions(cwd, ctx.inputs.baseUrl, model, fallbacks);
			try {
				return await ctx.stage(name, options as never).complete(`label:${ctx.inputs.role}`);
			} catch (error) {
				return `failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		if (ctx.inputs.role === "early") {
			const earlyCooldownMs = await ctx.tool("early-cooldown", {}, async () => providerCooldownMs(EARLY_PROVIDER));
			return { sawLimits: false, limitedUntil: 0, earlyCooldownMs, replies: [] };
		}
		if (ctx.inputs.role === "first") {
			let limitedUntil = 0;
			// Looked up by name: a build without limit observers then fails on the pool's behavior, not here.
			const stop =
				"observeProviderRateLimits" in atomic
					? atomic.observeProviderRateLimits((limit) => {
							if (limit.model === LIMITED_MODEL && limit.kind === "cooldown") limitedUntil = limit.untilEpochMs;
						})
					: () => {};
			let done = "the first worker's stages threw";
			try {
				// The 429 first: the pool sends each scope's first limit at once over ordered channels, so a worker
				// that holds the later quota mark has already applied this cooldown, unless it had ended.
				const replies = [await ask("limited", LIMITED_MODEL), await ask("quota", QUOTA_MODEL)];
				done = replies.join("; ");
				return { sawLimits: true, limitedUntil, earlyCooldownMs: 0, replies };
			} catch (error) {
				done = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				stop();
				// Tells a waiting second worker this worker is done, with or without the provider's limits.
				await fetch(`${ctx.inputs.baseUrl}/first-done`, { method: "POST", body: done });
			}
		}
		// Wait, however long the first worker's stages take, until the provider has sent both limits, or the
		// first worker has ended without them.
		for (;;) {
			const status = (await (await fetch(`${ctx.inputs.baseUrl}/limits-sent`)).json()) as LimitsSentStatus;
			if (status.sent429 && status.sent402) break;
			if (status.firstDone !== undefined) {
				const missing = [
					...(status.sent429 ? [] : ["429 rate-limit"]),
					...(status.sent402 ? [] : ["402 quota-exhausted"]),
				].join(" and ");
				throw new Error(
					`The provider never sent the ${missing} response the first worker should have met: ${status.firstDone}`,
				);
			}
			await delay(25);
		}
		// From here only the pool's message hop remains; the bound only keeps an unfixed pool from hanging. The
		// quota mark lasts an hour, so however slow that hop is, the mark is still running when it arrives.
		let sawLimits = false;
		for (const deadline = Date.now() + 30_000; Date.now() < deadline; await delay(10))
			if (providerUnavailableMs(LIMITED_PROVIDER, QUOTA_MODEL) > 0) {
				sawLimits = true;
				break;
			}
		const replies = [
			await ask("walk", QUOTA_MODEL, [SPARE_MODEL]),
			await ask("spare", SPARE_MODEL),
			await ask("limited", LIMITED_MODEL),
		];
		return { sawLimits, limitedUntil: 0, earlyCooldownMs: 0, replies };
	},
});
