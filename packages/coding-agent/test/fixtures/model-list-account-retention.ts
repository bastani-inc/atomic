import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

const bodies: WeakRef<object>[] = [];
globalThis.fetch = (async (input) => {
	const url = input instanceof Request ? input.url : String(input);
	if (!url.endsWith("/models/user")) return new Response(null, { status: 404 });
	const response = Response.json({ data: [{ id: "openai/gpt-4o" }] });
	const decode = response.json.bind(response);
	response.json = async () => {
		const body = await decode();
		bodies.push(new WeakRef(body));
		return body;
	};
	return response;
}) as typeof fetch;
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let hold = false;
const credentials = (key: string) => AuthStorage.inMemory({ openrouter: { type: "api_key", key } });
const slow = await ModelRuntime.create({
	credentials: credentials("fixture-slow"), modelsPath: null, modelRefreshTimeoutMs: 60_000,
	modelsStore: {
		read: async (id) => {
			if (hold && id === "openrouter") { entered.resolve(); await release.promise; }
			return undefined;
		}, write: async () => {}, delete: async () => {},
	},
});
hold = true;
const listing = slow.getAvailable("openrouter");
await entered.promise;
try {
	for (let i = 0; i < 8; i++) {
		const runtime = await ModelRuntime.create({ credentials: credentials(`fixture-${i}`), modelsPath: null });
		await runtime.getAvailable("openrouter");
	}
	for (let i = 0; i < 8; i++) { await Bun.sleep(15); Bun.gc(true); }
	console.log(JSON.stringify({ decoded: bodies.length, retained: bodies.filter((body) => body.deref()).length }));
} finally { release.resolve(); await listing; }
