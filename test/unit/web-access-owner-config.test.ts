import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const config = vi.hoisted(() => ({ path: "" }));
vi.mock("../../packages/web-access/config-paths.ts", () => ({
	findReadableConfigPath: () => config.path,
	EXA_USAGE_PATH: "",
}));

// #3105: shared imports retain per-owner caches, without changing credential discovery.
test("provider configuration is cached per lifecycle owner and survives reporter replacement", async () => {
	const directory = makeTempDirectory("web-owner-config-");
	config.path = join(directory, "web-search.json");
	const key = Symbol.for("atomic.builtin-diagnostic-context.v1");
	const host = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<object> };
	const previous = host[key];
	const context = new AsyncLocalStorage<object>();
	host[key] = context;
	const scope = {};
	const reporter = (owner: object) => Object.assign(() => {}, { [Symbol.for("atomic.builtin-owner.v1")]: owner });
	vi.stubEnv("GEMINI_API_KEY", "");
	try {
		vi.stubEnv("PERPLEXITY_API_KEY", "");
		vi.stubEnv("EXA_API_KEY", "");
		vi.stubEnv("YDC_API_KEY", "");
		const video = join(directory, "video.mp4");
		await writeFileEnsuringDir(video, "fixture");
		await writeFileEnsuringDir(
			config.path,
			JSON.stringify({
				youtube: { enabled: false },
				video: { enabled: false },
				searchModel: "first-model",
				geminiApiKey: "first-key",
				perplexityApiKey: "first-key",
				exaApiKey: "first-key",
				youcomApiKey: "first-key",
				chromeProfile: "first-profile",
				githubClone: { maxRepoSizeMB: 100 },
			}),
		);
		const { getApiKey } = await import("../../packages/web-access/gemini-api.js");
		const { isPerplexityAvailable } = await import("../../packages/web-access/perplexity.js");
		const { hasExaApiKey } = await import("../../packages/web-access/exa.js");
		const { isYoucomAvailable } = await import("../../packages/web-access/youcom.js");
		const { getChromeProfileFromConfig } = await import("../../packages/web-access/gemini-web-config.js");
		const { loadGitHubConfig, resetGitHubConfig } = await import("../../packages/web-access/github-config.js");
		const { isYouTubeEnabled } = await import("../../packages/web-access/youtube-extract.js");
		const { isVideoFile } = await import("../../packages/web-access/video-extract.js");
		const readVideo = () => [isYouTubeEnabled(), isVideoFile(video) !== null];
		assert.deepEqual(context.run(reporter(scope), readVideo), [false, false]);
		const read = () => [
			isPerplexityAvailable(),
			hasExaApiKey(),
			isYoucomAvailable(),
			getChromeProfileFromConfig(),
			loadGitHubConfig().maxRepoSizeMB,
		];
		assert.deepEqual(context.run(reporter(scope), read), [true, true, true, "first-profile", 100]);
		assert.equal(context.run(reporter(scope), getApiKey), "first-key");
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] } }] });
		});
		const { search } = await import("../../packages/web-access/gemini-search.js");
		await context.run(reporter(scope), () => search("query", { provider: "gemini" }));
		assert.match(urls.pop()!, /first-model/);
		await writeFileEnsuringDir(
			config.path,
			JSON.stringify({ searchModel: "second-model", geminiApiKey: "second-key" }),
		);
		assert.equal(context.run(reporter({}), getApiKey), "second-key");
		assert.deepEqual(context.run(reporter({}), read), [false, false, false, undefined, 350]);
		context.run(reporter({}), resetGitHubConfig);
		assert.deepEqual(context.run(reporter(scope), read), [true, true, true, "first-profile", 100]);
		assert.equal(context.run(reporter(scope), getApiKey), "first-key");
		assert.deepEqual(context.run(reporter({}), readVideo), [true, true]);
		assert.deepEqual(context.run(reporter(scope), readVideo), [false, false]);
		await context.run(reporter({}), () => search("query", { provider: "gemini" }));
		assert.match(urls.pop()!, /second-model/);
		await context.run(reporter(scope), () => search("query", { provider: "gemini" }));
		assert.match(urls.pop()!, /first-model/);
	} finally {
		host[key] = previous;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		removeTempDirectory(directory);
	}
});
