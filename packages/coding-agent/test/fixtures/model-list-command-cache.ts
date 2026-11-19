import { AuthStorage } from "../../src/core/auth-storage.ts";
import { findInitialModel } from "../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

// A fresh process has never resolved the configured command. It may read the stored catalog without running it.
const provider = "github-copilot";
let requests = 0;
globalThis.fetch = (async () => {
	requests++;
	throw new Error("unexpected network request");
}) as typeof fetch;
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: process.argv[2] });
const ids = (await runtime.getAvailable(provider)).map((model) => model.id).sort();
const { fallbackMessage } = await findInitialModel({
	modelRuntime: runtime,
	scopedModels: [],
	isContinuing: false,
	defaultProvider: provider,
	defaultModelId: "example-unlisted-model",
});
console.log(JSON.stringify({ ids, requests, fallbackMessage }));
