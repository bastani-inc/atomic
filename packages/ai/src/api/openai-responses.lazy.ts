import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { loadOpenAITransport } from "./load-openai-transport.ts";

export const openAIResponsesApi = (): ProviderStreams =>
	lazyApi(() => loadOpenAITransport(() => import("./openai-responses.ts")));
