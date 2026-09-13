import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { validateToolArguments } from "@bastani/pi-ai";
import { Value } from "typebox/value";
import { test, vi } from "vitest";

interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

interface ContentToolsModule {
	registerContentTools(
		pi: ExtensionAPI,
		deps: {
			maxInlineContent: number;
			stripThumbnails(results: ExtractedContent[]): ExtractedContent[];
			formatFullResults(): string;
		},
	): void;
}

interface WebAccessModule {
	default(pi: ExtensionAPI): void;
}

const fetchAllContent = vi.hoisted(() =>
	vi.fn(
		async (urls: string[]): Promise<ExtractedContent[]> =>
			urls.map((url) => ({
				url,
				title: "Example",
				content: "Example content",
				error: null,
			})),
	),
);
vi.mock("../../packages/web-access/extract.js", () => ({ fetchAllContent }));
vi.mock("../../packages/web-access/code-search.js", () => ({ executeCodeSearch: vi.fn() }));
vi.mock("../../packages/web-access/storage.js", () => ({
	generateId: () => "fetch-test",
	getResult: vi.fn(),
	storeResult: vi.fn(),
}));

// Keep excluded legacy web-access sources out of the root typecheck, while testing the real modules.
const { registerContentTools } = await vi.importActual<ContentToolsModule>(
	"../../packages/web-access/content-tools.js",
);
const { default: registerWebAccess } = await vi.importActual<WebAccessModule>("../../packages/web-access/index.js");

function capture(register: (pi: ExtensionAPI) => void): ToolDefinition {
	const tools: ToolDefinition[] = [];
	const pi: Pick<ExtensionAPI, "registerTool" | "on" | "registerShortcut" | "registerCommand" | "appendEntry"> = {
		registerTool: (tool) => {
			tools.push(tool);
		},
		on: () => {},
		registerShortcut: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
	};
	register(pi as ExtensionAPI);
	const tool = tools.find((tool) => tool.name === "fetch_content");
	assert.ok(tool);
	return tool;
}

const registrations = {
	lazy: () => capture(registerWebAccess),
	heavy: () =>
		capture((pi) =>
			registerContentTools(pi, {
				maxInlineContent: 1000,
				stripThumbnails: (results) => results,
				formatFullResults: () => "",
			}),
		),
};

test("lazy and loaded fetch_content expose the same argument guidance", () => {
	const lazy = registrations.lazy();
	const heavy = registrations.heavy();
	assert.equal(lazy.description, heavy.description);
	assert.equal(lazy.promptSnippet, heavy.promptSnippet);
	assert.deepEqual(lazy.parameters, heavy.parameters);
});

for (const [name, register] of Object.entries(registrations)) {
	test(`${name} fetch_content requires one nonempty urls array`, () => {
		const { parameters } = register();
		assert.ok(
			"properties" in parameters && typeof parameters.properties === "object" && parameters.properties !== null,
		);
		assert.equal("url" in parameters.properties, false);
		for (const input of [
			{},
			{ url: "https://example.com" },
			{ URLs: ["https://example.com"] },
			{ urls: [] },
			{ urls: "https://example.com" },
			{ urls: [{ url: "https://example.com" }] },
			{ urls: [""] },
			{ urls: ["https://example.com"], url: "https://other.example" },
		]) {
			assert.equal(Value.Check(parameters, input), false, JSON.stringify(input));
			if (typeof input.urls !== "string") {
				const tool = register();
				assert.throws(
					() =>
						validateToolArguments(tool, {
							type: "toolCall",
							id: "invalid",
							name: tool.name,
							arguments: input,
						}),
					/Validation failed for tool "fetch_content"/,
				);
			}
		}
		for (const urls of [
			["https://example.com"],
			["https://example.com", "https://other.example"],
			["/tmp/video.mp4"],
		]) {
			assert.equal(Value.Check(parameters, { urls }), true);
		}
	});

	test(`${name} fetch_content retains host normalization of a scalar urls string`, () => {
		const tool = register();
		assert.deepEqual(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "scalar",
				name: tool.name,
				arguments: { urls: "https://example.com" },
			}),
			{ urls: ["https://example.com"] },
		);
	});
}

test("fetch_content passes single and multiple URLs to extraction unchanged", async () => {
	const tool = registrations.heavy();
	for (const urls of [["https://example.com"], ["https://example.com", "https://other.example"]]) {
		const result = await tool.execute(
			"test",
			{ urls },
			new AbortController().signal,
			undefined,
			{} as ExtensionContext,
		);
		assert.deepEqual(fetchAllContent.mock.lastCall?.[0], urls);
		assert.ok(typeof result.details === "object" && result.details !== null && "successful" in result.details);
		assert.equal(result.details.successful, urls.length);
	}
});

test("fetch_content reports each failed URL and recovery steps when a batch fails", async () => {
	const urls = ["https://example.com/blocked", "https://example.com/timeout"];
	fetchAllContent.mockResolvedValueOnce([
		{ url: urls[0], title: "", content: "", error: "HTTP 403 Forbidden" },
		{ url: urls[1], title: "", content: "", error: "Request timed out" },
	]);
	const result = await registrations
		.heavy()
		.execute("test", { urls }, new AbortController().signal, undefined, {} as ExtensionContext);
	assert.ok(typeof result.details === "object" && result.details !== null && "error" in result.details);
	const error = result.details.error;
	assert.equal(typeof error, "string");
	assert.match(String(error), /All 2 URL fetch\(es\) failed\. No content was retrieved/);
	assert.match(String(error), /https:\/\/example.com\/blocked: Error - HTTP 403 Forbidden/);
	assert.match(String(error), /https:\/\/example.com\/timeout: Error - Request timed out/);
	assert.match(String(error), /fetch_content\(\{ urls: \["<failed URL>"\] \}\)/);
	assert.match(String(error), /web_search/);
	assert.match(String(error), /get_search_content cannot recover content/);
	assert.doesNotMatch(String(error), /to retrieve full content/);
	assert.deepEqual(result.content, [{ type: "text", text: error }]);
});

// PR #3002: extraction errors can retain useful partial markdown.
test("fetch_content exposes retained excerpts when every extraction reports an error", async () => {
	const urls = ["https://example.com/empty", "https://example.com/partial"];
	for (const firstContent of ["", "First retained excerpt"]) {
		fetchAllContent.mockResolvedValueOnce([
			{ url: urls[0], title: "", content: firstContent, error: "Incomplete extraction" },
			{ url: urls[1], title: "", content: "Retained evidence " + "x".repeat(1100), error: "Incomplete extraction" },
		]);
		const result = await registrations
			.heavy()
			.execute("test", { urls }, new AbortController().signal, undefined, {} as ExtensionContext);
		assert.ok(typeof result.details === "object" && result.details !== null && "error" in result.details);
		assert.ok("outcome" in result.details && result.details.outcome === "all_failed");
		assert.ok("successful" in result.details && result.details.successful === 0);
		const text = String(result.details.error);
		assert.match(text, /Partial content was retained/);
		assert.match(text, /https:\/\/example.com\/partial: Error - Incomplete extraction/);
		assert.match(text, /Partial content \(incomplete\):\nRetained evidence/);
		assert.match(text, /Partial content truncated/);
		assert.doesNotMatch(text, /x{1001}/);
		if (firstContent) assert.ok(text.includes(firstContent));
		assert.doesNotMatch(text, /No content was retrieved|cannot recover content from these failed fetches/);
		assert.match(text, /Retry transient failures/);
		assert.deepEqual(result.content, [{ type: "text", text }]);
	}
});

test("fetch_content preserves successful content retrieval guidance for mixed batches", async () => {
	const urls = ["https://example.com/good", "https://example.com/blocked"];
	fetchAllContent.mockResolvedValueOnce([
		{ url: urls[0], title: "Good page", content: "Readable content", error: null },
		{ url: urls[1], title: "", content: "", error: "HTTP 403 Forbidden" },
	]);
	const result = await registrations
		.heavy()
		.execute("test", { urls }, new AbortController().signal, undefined, {} as ExtensionContext);
	assert.ok(typeof result.details === "object" && result.details !== null);
	assert.equal("error" in result.details, false);
	const text = result.content.find((item) => item.type === "text");
	assert.ok(text?.type === "text");
	assert.match(text.text, /Good page/);
	assert.match(text.text, /HTTP 403 Forbidden/);
	assert.match(text.text, /get_search_content.*to retrieve full content/);
});
