import assert from "node:assert/strict";
import { truncateSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

vi.mock("@bastani/atomic", () => ({
	CONFIG_DIR_NAME: ".atomic",
	APP_NAME: "atomic",
	getUserConfigPaths: () => [],
}));
const config = vi.hoisted(() => ({ path: "" }));
vi.mock("../../packages/web-access/config-paths.ts", () => ({
	findReadableConfigPath: () => config.path,
	EXA_USAGE_PATH: "",
}));
const geminiWeb = vi.hoisted(() => ({ available: false }));
vi.mock("../../packages/web-access/gemini-web.js", () => ({
	isGeminiWebAvailable: async () => (geminiWeb.available ? { cookie: "value" } : null),
	queryWithCookies: async () => "# Clip summary\n\nTranscript",
}));

interface Result {
	url: string;
	content: string;
	error: string | null;
}

const MB = 1024 * 1024;
const API_KEY = "test-gemini-key-123";
let directory: string;

/** Import a fresh copy so each test reads its own `video` settings. These legacy sources are excluded from the root typecheck. */
async function loadExtractContent() {
	vi.resetModules();
	const { extractContent } = await vi.importActual<{ extractContent(url: string): Promise<Result> }>(
		"../../packages/web-access/extract.js",
	);
	return extractContent;
}

function videoFile(sizeBytes: number): string {
	const path = join(directory, "clip.mp4");
	writeTextSync(path, "");
	truncateSync(path, sizeBytes);
	return path;
}

beforeEach(() => {
	directory = makeTempDirectory("atomic-video-errors-");
	config.path = join(directory, "web-search.json");
	vi.stubEnv("GEMINI_API_KEY", API_KEY);
	geminiWeb.available = false;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	removeTempDirectory(directory);
});

test("a local video over video.maxSizeMB reports the size limit instead of Invalid URL (#4898)", async () => {
	const fetch = vi.fn(async (_input: string | URL | Request) => new Response("unexpected", { status: 500 }));
	vi.stubGlobal("fetch", fetch);
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(60 * MB));

	assert.match(result.error ?? "", /clip\.mp4 exceeds the 50 MB video limit \(video\.maxSizeMB\)$/);
	assert.equal(fetch.mock.calls.length, 0);
});

test("a local video with video extraction disabled says so instead of Invalid URL (#4898)", async () => {
	writeTextSync(config.path, JSON.stringify({ video: { enabled: false } }));
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(1024));

	assert.match(result.error ?? "", /clip\.mp4: video extraction is disabled \(video\.enabled\)$/);
});

test("a Gemini API quota error on a local video is reported instead of asking for a key (#4898)", async () => {
	const fetch = vi.fn(
		async (_input: string | URL | Request) =>
			new Response('{"error":{"code":429,"message":"Quota exceeded"}}', { status: 429 }),
	);
	vi.stubGlobal("fetch", fetch);
	const extractContent = await loadExtractContent();

	// Exactly at the size limit is still allowed.
	const path = videoFile(50 * MB);
	const result = await extractContent(path);

	assert.deepEqual(result, {
		url: path,
		title: "",
		content: "",
		error: 'Gemini API video analysis failed: File upload init failed: 429 ({"error":{"code":429,"message":"Quota exceeded"}})',
	});
	assert.match(String(fetch.mock.calls[0]?.[0]), /^https:\/\/generativelanguage\.googleapis\.com\/upload\//);
});

test("Gemini API video errors never include the API key (#4898)", async () => {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/upload/v1beta/files")) {
			return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/session" } });
		}
		if (url === "https://upload.example/session") {
			return Response.json({ file: { name: "files/abc", uri: "https://files.example/abc" } });
		}
		if (init?.method === "DELETE") return new Response("{}");
		throw new Error(`request to ${url} failed`);
	});
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(1024));

	assert.equal(
		result.error,
		"Gemini API video analysis failed: request to https://generativelanguage.googleapis.com/v1beta/files/abc?key=[redacted] failed",
	);
});

test("a failed Gemini file state check reports its status and message (#4898)", async () => {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/upload/v1beta/files")) {
			return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/session" } });
		}
		if (url === "https://upload.example/session") {
			return Response.json({ file: { name: "files/abc", uri: "https://files.example/abc" } });
		}
		if (init?.method === "DELETE") return new Response("{}");
		return new Response(`permission denied ${"x".repeat(300)}`, { status: 403 });
	});
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(1024));

	assert.equal(
		result.error,
		`Gemini API video analysis failed: File state check failed: 403 (permission denied ${"x".repeat(182)})`,
	);
});

test("without a Gemini API key a local video still uses Gemini Web (#4898)", async () => {
	vi.stubEnv("GEMINI_API_KEY", "");
	geminiWeb.available = true;
	const extractContent = await loadExtractContent();

	const path = videoFile(1024);
	const result = await extractContent(path);

	assert.equal(result.error, null);
	assert.equal(result.content, "# Clip summary\n\nTranscript");
});

test("without any Gemini access a local video asks for it (#4898)", async () => {
	vi.stubEnv("GEMINI_API_KEY", "");
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(1024));

	assert.match(result.error ?? "", /^Video analysis requires Gemini access/);
});

test("a successful Gemini API analysis of a local video returns its text (#4898)", async () => {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/upload/v1beta/files")) {
			return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.example/session" } });
		}
		if (url === "https://upload.example/session") {
			return Response.json({ file: { name: "files/abc", uri: "https://files.example/abc" } });
		}
		if (init?.method === "DELETE") return new Response("{}");
		if (url.includes(":generateContent")) {
			return Response.json({ candidates: [{ content: { parts: [{ text: "# Clip\n\nTranscript" }] } }] });
		}
		return Response.json({ state: "ACTIVE" });
	});
	const extractContent = await loadExtractContent();

	const result = await extractContent(videoFile(1024));

	assert.equal(result.error, null);
	assert.equal(result.content, "# Clip\n\nTranscript");
});
