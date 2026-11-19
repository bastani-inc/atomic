import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { loadOpenAITransport } from "./load-openai-transport.ts";

export const openAICompletionsApi = (): ProviderStreams =>
	lazyApi(() => loadOpenAITransport(() => import("./openai-completions.ts")));
