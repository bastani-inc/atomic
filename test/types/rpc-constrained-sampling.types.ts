import type { ModelInfo, RpcClient } from "@bastani/atomic";

// Existing consumers can keep constructing the original four-field shape.
export const legacyModelInfo: ModelInfo = {
	provider: "example",
	id: "legacy",
	contextWindow: 32_000,
	reasoning: false,
};

// RPC consumers can inspect every constrained-sampling capability advertised by Atomic.
export async function readRpcConstrainedSamplingCapabilities(client: RpcClient): Promise<void> {
	const compat = (await client.getAvailableModels())[0]?.compat;
	const strictTools: boolean | undefined = compat?.supportsStrictTools;
	const strictMode: boolean | undefined = compat?.supportsStrictMode;
	const canonicalGrammar: boolean | undefined = compat?.supportsOpenAIGrammarTools;
	const atomicGrammarAlias: boolean | undefined = compat?.supportsGrammarTools;
	void [strictTools, strictMode, canonicalGrammar, atomicGrammarAlias];
}
