import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const config = vi.hoisted(() => ({ path: "" }));
vi.mock("../../packages/web-access/config-paths.ts", () => ({
	findReadableConfigPath: () => config.path,
	EXA_USAGE_PATH: "",
}));

test("a pending GitHub configuration load cannot repopulate its owner's reset cache (#5285)", async () => {
	const directory = makeTempDirectory("web-owner-config-reset-");
	config.path = join(directory, "web-search.json");
	const key = Symbol.for("atomic.builtin-diagnostic-context.v1");
	const host = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<object> };
	const previous = host[key];
	const context = new AsyncLocalStorage<object>();
	host[key] = context;
	const reporter = (owner: object) => Object.assign(() => {}, { [Symbol.for("atomic.builtin-owner.v1")]: owner });
	const first = reporter({});
	const second = reporter({});
	vi.resetModules();
	try {
		const { loadGitHubConfig, resetGitHubConfig } = await import("../../packages/web-access/github-config.js");
		const writeConfig = (maxRepoSizeMB: number) =>
			writeFileSync(config.path, JSON.stringify({ githubClone: { clonePath: directory, maxRepoSizeMB } }));
		writeConfig(100);
		assert.equal((await context.run(second, loadGitHubConfig)).maxRepoSizeMB, 100);
		const pending = context.run(first, loadGitHubConfig);
		context.run(first, resetGitHubConfig);
		writeConfig(200);
		assert.equal((await pending).maxRepoSizeMB, 100, "the earlier caller keeps its own configuration");
		assert.equal(
			(await context.run(first, loadGitHubConfig)).maxRepoSizeMB,
			200,
			"reset invalidates the pending load",
		);
		assert.equal(
			(await context.run(second, loadGitHubConfig)).maxRepoSizeMB,
			100,
			"another owner's cache is unchanged",
		);
	} finally {
		host[key] = previous;
		removeTempDirectory(directory);
		vi.resetModules();
	}
});

test("a reset discards the pending default GitHub clone path and missing-file configuration (#5285)", async () => {
	const directory = makeTempDirectory("web-default-config-reset-");
	config.path = join(directory, "web-search.json");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(directory, "agent"));
	vi.stubEnv("XDG_RUNTIME_DIR", "");
	vi.resetModules();
	try {
		const { chosenDefaultGitHubClonePath, loadGitHubConfig, resetGitHubConfig } = await import(
			"../../packages/web-access/github-config.js"
		);
		const pending = loadGitHubConfig();
		resetGitHubConfig();
		writeFileSync(config.path, JSON.stringify({ githubClone: { clonePath: directory, maxRepoSizeMB: 200 } }));
		assert.equal((await pending).maxRepoSizeMB, 350, "the earlier caller keeps the missing-file defaults");
		assert.equal(chosenDefaultGitHubClonePath(), null, "the earlier default-path read cannot repopulate the cache");
		assert.equal((await loadGitHubConfig()).maxRepoSizeMB, 200, "the next load reads the new configuration");
	} finally {
		vi.unstubAllEnvs();
		removeTempDirectory(directory);
		vi.resetModules();
	}
});

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
				chromeProfile: "first-profile",
				githubClone: { maxRepoSizeMB: 100 },
			}),
		);
		const { getApiKey } = await import("../../packages/web-access/gemini-api.js");
		const { isPerplexityAvailable } = await import("../../packages/web-access/perplexity.js");
		const { hasExaApiKey } = await import("../../packages/web-access/exa.js");
		const { getChromeProfileFromConfig } = await import("../../packages/web-access/gemini-web-config.js");
		const { loadGitHubConfig, resetGitHubConfig } = await import("../../packages/web-access/github-config.js");
		const { isYouTubeEnabled } = await import("../../packages/web-access/youtube-extract.js");
		const { isVideoFile } = await import("../../packages/web-access/video-extract.js");
		const videoEnabled = () => {
			try {
				return isVideoFile(video) !== null;
			} catch (err) {
				assert.match(String(err), /video extraction is disabled \(video\.enabled\)/);
				return false;
			}
		};
		const readVideo = () => [isYouTubeEnabled(), videoEnabled()];
		assert.deepEqual(context.run(reporter(scope), readVideo), [false, false]);
		const read = async () => [
			isPerplexityAvailable(),
			hasExaApiKey(),
			getChromeProfileFromConfig(),
			(await loadGitHubConfig()).maxRepoSizeMB,
		];
		assert.deepEqual(await context.run(reporter(scope), read), [true, true, "first-profile", 100]);
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
		assert.deepEqual(await context.run(reporter({}), read), [false, false, undefined, 350]);
		context.run(reporter({}), resetGitHubConfig);
		assert.deepEqual(await context.run(reporter(scope), read), [true, true, "first-profile", 100]);
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
