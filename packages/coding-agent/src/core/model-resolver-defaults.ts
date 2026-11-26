import type { Api, Model } from "@bastani/atomic-ai/compat";

/** Preferred model IDs. Resolve them against the available catalog before selection. */
export const defaultModelPerProvider: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-5-5",
	anthropic: "claude-opus-5-5",
	"anthropic-api": "claude-opus-5-5",
	openai: "gpt-6.2-sol",
	"openai-api": "gpt-6.2-sol",
	azure: "gpt-6.2-sol",
	"openai-codex": "gpt-6.2-sol",
	nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-4-argon",
	"google-vertex": "gemini-4-argon",
	"github-copilot": "gpt-6.1-sol",
	openrouter: "moonshotai/kimi-k2.7-code",
	"vercel-ai-gateway": "zai/glm-5.3",
	xai: "grok-4.7",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	"ant-ling": "Ring-2.6-1T",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "mistral-large-latest",
	minimax: "MiniMax-M3",
	"minimax-cn": "MiniMax-M3",
	moonshotai: "kimi-k2.7-code",
	"moonshotai-cn": "kimi-k2.7-code",
	huggingface: "moonshotai/Kimi-K2.7-Code",
	fireworks: "accounts/fireworks/models/kimi-k3",
	together: "moonshotai/Kimi-K3",
	baseten: "zai-org/GLM-5.3",
	opencode: "kimi-k2.7-code",
	"opencode-go": "kimi-k3.1-pro",
	"kimi-coding": "kimi-for-coding",
	meta: "muse-spark-1.3",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.7-code",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.7-code",
	"qwen-token-plan": "qwen3.8-max",
	"qwen-token-plan-cn": "qwen3.8-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	"qwen-token-plan-individual-cn": "qwen3.8-max",
	xiaomi: "mimo-v2.6-pro",
	"xiaomi-token-plan-cn": "mimo-v2.6-pro",
	"xiaomi-token-plan-ams": "mimo-v2.6-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

export function findProviderDefaultModel(
	provider: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (!Object.hasOwn(defaultModelPerProvider, provider)) return undefined;
	const preferredId = defaultModelPerProvider[provider];
	const namespace = preferredId.split("/").slice(0, -1);
	let fallback: Model<Api> | undefined;
	let bestSharedDepth = -1;
	for (const model of availableModels) {
		if (model.provider !== provider) continue;
		if (model.id === preferredId) return model;
		const modelNamespace = model.id.split("/").slice(0, -1);
		let sharedDepth = 0;
		while (sharedDepth < namespace.length && namespace[sharedDepth] === modelNamespace[sharedDepth]) sharedDepth++;
		if (!fallback || sharedDepth > bestSharedDepth || (sharedDepth === bestSharedDepth && model.id < fallback.id)) {
			fallback = model;
			bestSharedDepth = sharedDepth;
		}
	}
	return fallback;
}

export function findPreferredAvailableModel(availableModels: readonly Model<Api>[]): Model<Api> | undefined {
	for (const [provider, defaultId] of Object.entries(defaultModelPerProvider)) {
		const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
		if (match) {
			return match;
		}
	}

	const first = availableModels[0];
	return first && (findProviderDefaultModel(first.provider, availableModels) ?? first);
}
