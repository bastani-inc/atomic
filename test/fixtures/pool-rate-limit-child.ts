import { setTimeout as delay } from "node:timers/promises";
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
 * Role `first` meets the provider's limits: an exhausted quota on one model, then a 429 on another.
 * Role `second` waits until both limits reach its own process, then asks the quota model with a fallback,
 * the spare model, and the rate-limited model, in that order. Role `early` reports the cooldown of
 * {@link EARLY_PROVIDER} it sees as it starts.
 */
export const child = workflow({
	name: "pool-rate-limit-child",
	description: "Provider limits shared across a local worker pool",
	inputs: { role: Type.String(), baseUrl: Type.String() },
	outputs: { sawLimits: Type.Boolean(), earlyCooldownMs: Type.Number(), replies: Type.Array(Type.String()) },
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
			return { sawLimits: false, earlyCooldownMs, replies: [] };
		}
		if (ctx.inputs.role === "first") {
			const replies = [await ask("quota", QUOTA_MODEL), await ask("limited", LIMITED_MODEL)];
			return { sawLimits: true, earlyCooldownMs: 0, replies };
		}
		let sawLimits = false;
		for (const deadline = Date.now() + 20_000; Date.now() < deadline; await delay(10)) {
			if (
				providerCooldownMs(LIMITED_PROVIDER, LIMITED_MODEL) > 0 &&
				providerUnavailableMs(LIMITED_PROVIDER, QUOTA_MODEL) > 0
			) {
				sawLimits = true;
				break;
			}
		}
		const replies = [
			await ask("walk", QUOTA_MODEL, [SPARE_MODEL]),
			await ask("spare", SPARE_MODEL),
			await ask("limited", LIMITED_MODEL),
		];
		return { sawLimits, earlyCooldownMs: 0, replies };
	},
});
