import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { makeDirectorySync, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

vi.mock("@bastani/atomic", () => ({
	CONFIG_DIR_NAME: ".atomic",
	APP_NAME: "atomic",
	getUserConfigPaths: () => [],
}));
vi.mock("../../packages/web-access/github-extract.js", () => ({ extractGitHub: async () => null }));
vi.mock("../../packages/web-access/gemini-url-context.js", () => ({
	extractWithUrlContext: async () => null,
	extractWithGeminiWeb: async () => null,
}));

interface Options {
	frames?: number;
	timestamp?: string;
}
interface Result {
	url: string;
	content: string;
	error: string | null;
}
// These legacy sources are excluded from the root typecheck.
const { extractContent, fetchAllContent } = await vi.importActual<{
	extractContent(url: string, signal?: AbortSignal, options?: Options): Promise<Result>;
	fetchAllContent(urls: string[], signal?: AbortSignal, options?: Options): Promise<Result[]>;
}>("../../packages/web-access/extract.js");

afterEach(() => vi.unstubAllGlobals());

test("webpages remain readable when video frame options are supplied", async () => {
	const paragraph = "This article explains how to fetch readable webpage content without video extraction. ".repeat(
		20,
	);
	const fetch = vi.fn(
		async () =>
			new Response(
				`<html><head><title>Article</title></head><body><article><p>${paragraph}</p></article></body></html>`,
				{
					headers: { "content-type": "text/html" },
				},
			),
	);
	vi.stubGlobal("fetch", fetch);
	for (const options of [{ frames: 1 }, { timestamp: "1:23" }, { frames: 3, timestamp: "invalid" }]) {
		const result = await extractContent("https://example.com/article", undefined, options);
		assert.equal(result.error, null);
		assert.match(result.content, /This article explains/);
	}
	assert.equal(fetch.mock.calls.length, 3);
});

test("mixed batches ignore video options for pages but validate YouTube timestamps", async () => {
	const page = "https://example.com/article";
	const youtube = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
	const paragraph = "This article remains readable in a mixed batch with a video. ".repeat(20);
	const fetch = vi.fn(
		async () =>
			new Response(`<html><body><article><p>${paragraph}</p></article></body></html>`, {
				headers: { "content-type": "text/html" },
			}),
	);
	vi.stubGlobal("fetch", fetch);
	const results = await fetchAllContent([page, youtube], undefined, { frames: 3, timestamp: "invalid" });
	assert.deepEqual(
		results.map((result) => result.url),
		[page, youtube],
	);
	assert.equal(results[0]?.error, null);
	assert.match(results[0]?.content ?? "", /This article remains readable/);
	assert.match(results[1]?.error ?? "", /Invalid timestamp format: "invalid"/);
	assert.equal(fetch.mock.calls.length, 1);
});

test("aborted batches do not fetch pages or validate video timestamps", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const urls = ["https://example.com/article", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
	const results = await fetchAllContent(urls, AbortSignal.abort(), { frames: 3, timestamp: "invalid" });
	assert.deepEqual(
		results.map(({ url, content, error }) => ({ url, content, error })),
		urls.map((url) => ({ url, content: "", error: "Aborted" })),
	);
	assert.equal(fetch.mock.calls.length, 0);
});

test("ordinary text content is unchanged by video options", async () => {
	const content = "# Notes\n\nPlain text should not require video extraction.";
	const fetch = vi.fn(async () => new Response(content, { headers: { "content-type": "text/plain" } }));
	vi.stubGlobal("fetch", fetch);
	for (const options of [{ frames: 2 }, { timestamp: "1:23" }, { frames: 3, timestamp: "invalid" }]) {
		const result = await extractContent("https://example.com/notes.txt", undefined, options);
		assert.equal(result.error, null);
		assert.equal(result.content, content);
	}
	assert.equal(fetch.mock.calls.length, 3);
});

test("local videos still reject invalid timestamps before extraction", async () => {
	// PR #3016: use a supported relative path, including when Windows temp and cwd use different drives.
	const directory = `./.web-access-video-options-${randomUUID()}`;
	makeDirectorySync(directory);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	try {
		const video = `${directory}/clip.mp4`;
		// Timestamp validation precedes decoding, so no playable media or ffmpeg is needed.
		writeTextSync(video, "local video fixture");
		const result = await extractContent(video, undefined, { frames: 3, timestamp: "invalid" });
		assert.equal(result.url, video);
		assert.equal(result.content, "");
		assert.match(result.error ?? "", /Invalid timestamp format: "invalid"/);
		assert.equal(fetch.mock.calls.length, 0);
	} finally {
		removeTempDirectory(directory);
	}
});
