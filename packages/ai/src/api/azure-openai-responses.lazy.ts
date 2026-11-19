import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { loadOpenAITransport } from "./load-openai-transport.ts";

export const azureOpenAIResponsesApi = (): ProviderStreams =>
	lazyApi(() => loadOpenAITransport(() => import("./azure-openai-responses.ts")));
