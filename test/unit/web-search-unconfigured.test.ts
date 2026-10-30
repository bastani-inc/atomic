import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { getUserConfigPaths } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

// The web-access modules resolve their config paths from the home directory
// when they load, so the temporary home must exist before the dynamic import.
const previousEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	EXA_API_KEY: process.env.EXA_API_KEY,
	PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
	GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};
const home = mkdtempSync(join(tmpdir(), "web-search-unconfigured-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.EXA_API_KEY;
delete process.env.PERPLEXITY_API_KEY;
delete process.env.GEMINI_API_KEY;

const [configPath] = getUserConfigPaths("web-search.json");
assert.ok(configPath, "expected an Atomic web-search.json path");

interface WebSearchToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

interface WebSearchTool {
	execute(
		toolCallId: string,
		params: { query: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<WebSearchToolResult>;
}

interface WebSearchFeaturesModule {
	registerWebSearchFeatures(pi: ExtensionAPI, initConfig: Record<string, never>): void;
}

// vi.importActual keeps the web-access sources out of the root typecheck, as in the other web-search suites.
const { registerWebSearchFeatures } = await vi.importActual<WebSearchFeaturesModule>(
	"../../packages/web-access/web-search-features.js",
);

const EXA_MCP_BODY = `data: ${JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	result: {
		content: [
			{
				type: "text",
				text: "Title: Atomic docs\nURL: https://example.test/atomic\nText: Atomic is a coding agent.\n---\n",
			},
		],
	},
})}\n\n`;

let execCalls: string[] = [];
let tool: WebSearchTool;

function createPi(): ExtensionAPI {
	const fixture: Pick<
		ExtensionAPI,
		"on" | "registerShortcut" | "registerTool" | "registerCommand" | "appendEntry" | "sendMessage" | "exec"
	> = {
		on: (() => () => {}) as unknown as ExtensionAPI["on"],
		registerShortcut: () => {},
		registerCommand: () => {},
		registerTool: ((registered: { name: string }) => {
			if (registered.name === "web_search") tool = registered as unknown as WebSearchTool;
		}) as ExtensionAPI["registerTool"],
		appendEntry: (async () => {}) as ExtensionAPI["appendEntry"],
		sendMessage: (async () => {}) as ExtensionAPI["sendMessage"],
		// Stands in for the host's browser launcher: records the attempt and fails like a machine without a desktop.
		exec: (async (command: string) => {
			execCalls.push(command);
			return { stdout: "", stderr: `${command}: not found`, code: 127, killed: false, truncated: false };
		}) as ExtensionAPI["exec"],
	};
	return fixture as ExtensionAPI;
}

function createContext(options: { hasUI: boolean; hasHumanInput: boolean }): ExtensionContext {
	return {
		...options,
		mode: options.hasUI ? "tui" : "print",
		modelRegistry: { getAvailable: () => [] },
	} as unknown as ExtensionContext;
}

function writeConfig(contents: Record<string, unknown>): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(contents)}\n`);
}

function search(options: { hasUI: boolean; hasHumanInput: boolean }): Promise<WebSearchToolResult> {
	return tool.execute("call-1", { query: "atomic coding agent" }, undefined, undefined, createContext(options));
}

beforeEach(() => {
	execCalls = [];
	rmSync(configPath, { force: true });
	registerWebSearchFeatures(createPi(), {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(EXA_MCP_BODY, { status: 200 })),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

test("web_search with no provider configured returns raw results through Exa's keyless fallback (#4087)", async () => {
	const result = await search({ hasUI: true, hasHumanInput: true });

	assert.match(result.content[0]?.text ?? "", /Atomic is a coding agent\./);
	assert.match(result.content[0]?.text ?? "", /https:\/\/example\.test\/atomic/);
	assert.equal(result.details.cancelled, undefined);
	assert.deepEqual(execCalls, []);
});

test("web_search with the curator enabled skips it when the session has no human to answer it (#4087)", async () => {
	writeConfig({ workflow: "summary-review" });

	const result = await search({ hasUI: true, hasHumanInput: false });

	assert.match(result.content[0]?.text ?? "", /Atomic is a coding agent\./);
	assert.equal(result.details.cancelled, undefined);
	assert.deepEqual(execCalls, [], "a session without a human must not try to open the curator browser");
});

test("web_search falls back to raw results when the curator cannot open, instead of cancelling as stale (#4087)", async () => {
	writeConfig({ workflow: "summary-review" });

	const result = await search({ hasUI: true, hasHumanInput: true });

	const text = result.content[0]?.text ?? "";
	assert.notEqual(result.details.cancelled, true);
	assert.doesNotMatch(text, /curation cancelled/i);
	assert.match(text, /Atomic is a coding agent\./);
	assert.match(text, /curator/i);
	assert.match(text, /\/curator off/);
	assert.ok(execCalls.length > 0, "the curator browser launch should have been attempted");
});

test("web_search names the provider settings and /curator when no provider can be reached (#4087)", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("fetch failed");
		}),
	);

	const result = await search({ hasUI: false, hasHumanInput: false });

	const text = result.content[0]?.text ?? "";
	for (const expected of [
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
		"exaApiKey",
		"perplexityApiKey",
		"geminiApiKey",
		"web-search.json",
		"/curator",
	]) {
		assert.ok(text.includes(expected), `expected the error to mention ${expected}, got:\n${text}`);
	}
	assert.doesNotMatch(text, /curation cancelled/i);
});
