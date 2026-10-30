import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { createCodemodeDescription } from "../src/extensions/codemode/tool.js";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.js";
import {
	Bm25Ranker,
	createToolSearchDescription,
	createToolSearchDocument,
	tokenize,
} from "../src/extensions/tool-search/tool.js";
import { createHarness, getMessageText } from "./suite/harness.js";

test("tool search activates matching deferred tools for the next model call", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createToolSearchExtension(),
			(pi) => {
				pi.registerTool({
					name: "github_issues",
					label: "Issues",
					description: "Search repository issues",
					exposure: "deferred",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "issue 42" }], details: {} }),
				});
				pi.registerTool({
					name: "hidden_issues",
					label: "Hidden",
					description: "Search repository issues",
					exposure: "hidden",
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error("unreachable");
					},
				});
			},
		],
		initialActiveToolNames: ["tool_search"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "repository issue" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("github_issues", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find issue");
		assert(harness.session.getActiveToolNames().includes("github_issues"));
		assert(!harness.session.getActiveToolNames().includes("hidden_issues"));
		assert(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message) === "issue 42",
			),
		);
	} finally {
		await harness.cleanup();
	}
});

test("deferred tools do not change codemode or tool-search descriptions (#10212)", () => {
	const plain = {
		name: "plain",
		label: "Plain",
		description: "Plain tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
	const deferred = { ...plain, name: "later" };
	const namespaces = new Map([[deferred.name, { name: "later_namespace", description: "Late source" }]]);
	for (const inlineBudget of [undefined, 0, 100]) {
		assert.equal(
			createCodemodeDescription([plain, deferred], { namespaces, deferred: new Set([deferred.name]), inlineBudget }),
			createCodemodeDescription([plain], { inlineBudget }),
		);
		assert(
			!createCodemodeDescription([plain, deferred], {
				namespaces,
				deferred: new Set([deferred.name]),
				inlineBudget,
			}).includes("later_namespace"),
		);
	}
	assert.equal(createToolSearchDescription([...namespaces.values()]), createToolSearchDescription());
});

test("codemode describes all lookup helpers as async (#10555)", () => {
	const description = createCodemodeDescription([]);
	assert(description.includes("await searchTools(query, {limit?, namespace?})"));
	assert(description.includes("await describeTool(name)"));
	assert(description.includes("await describeNamespace(name)"));
});

test("tool search ranks a tool first when the query is its name (pi#11331)", () => {
	const documents = [
		{ name: "mcp__app__queue_read", description: "Read a queued message of this thread." },
		{
			name: "mcp__dev-app__thread_read",
			description:
				"Read durable state and a paginated timeline from any thread. The default view returns user messages, assistant messages and plans. Continue with afterPosition until hasMore is false.",
		},
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	const ranker = new Bm25Ranker();
	for (const query of [
		"thread_read",
		"dev_app__thread_read",
		"mcp__dev-app__thread_read",
		"Thread_Read",
		"thread read",
	]) {
		assert.deepEqual(
			ranker.rank(query, documents, 1).map((match) => match.name),
			["mcp__dev-app__thread_read"],
			query,
		);
	}
	// Partial names still rank by BM25.
	assert.deepEqual(
		ranker.rank("read", documents, 1).map((match) => match.name),
		["mcp__app__queue_read"],
	);
	// A lowercase query naming a camelCase tool shares no BM25 term with it, but still names it.
	const camel = [
		{ name: "mcp__app__queue_read", description: "Read a queued message of this thread." },
		{ name: "mcp__app__readThread", description: "Read a thread" },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	for (const query of ["readthread", "app__readthread"]) {
		assert.deepEqual(
			ranker.rank(query, camel, 1).map((match) => match.name),
			["mcp__app__readThread"],
			query,
		);
	}
});

test("tool search resolves the dotted, prefixed and bare forms of an MCP tool name (#4065)", () => {
	// Server `alteryx-local` sanitizes to `alteryx_local`; its tool names already contain `_`.
	const documents = [
		{ name: "mcp__alteryx_local__alteryx_local__get_server_info", description: "Server version." },
		{
			name: "mcp__alteryx_local__designer_local__get_server_info",
			description: "Get the Alteryx local server info: the alteryx local server version and local server info.",
		},
		{ name: "mcp__alteryx_local__alteryx_local__run_workflow", description: "Run a workflow." },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	const ranker = new Bm25Ranker();
	for (const query of [
		"mcp.alteryx-local.alteryx_local.get_server_info",
		"mcp__alteryx-local__alteryx_local__get_server_info",
		"alteryx-local__alteryx_local__get_server_info",
		"alteryx_local__get_server_info",
	]) {
		assert.deepEqual(
			ranker.rank(query, documents, 1).map((match) => match.name),
			["mcp__alteryx_local__alteryx_local__get_server_info"],
			query,
		);
	}
});

test("tool search resolves a dotted MCP name whose tool part contains dots and slashes (#4065)", () => {
	const documents = [
		{
			name: "mcp__my_server__get_item_v1",
			description: "Get the item v2 from my server: get item, server item v2, mcp server get item v2.",
		},
		{ name: "mcp__my_server__get_item_v2", description: "Fetch one record." },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	assert.deepEqual(
		new Bm25Ranker().rank("mcp.my-server.get.item/v2", documents, 1).map((match) => match.name),
		["mcp__my_server__get_item_v2"],
	);
});

test("tool search finds a tool whose name is only stop words, and nothing for other stop-word queries", () => {
	const documents = [
		{ name: "mcp__app__thread_read", description: "Read a thread." },
		{ name: "mcp__app__for_each", description: "Run a step for each item." },
		{ name: "mcp__app__is", description: "Check whether a value is set." },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	const ranker = new Bm25Ranker();
	for (const [query, expected] of [
		["is", "mcp__app__is"],
		["for_each", "mcp__app__for_each"],
		["app__is", "mcp__app__is"],
	] as const) {
		assert.deepEqual(
			ranker.rank(query, documents, 1).map((match) => match.name),
			[expected],
			query,
		);
	}
	assert.deepEqual(ranker.rank("the", documents, 5), []);
	assert.deepEqual(ranker.rank("of the", documents, 5), []);
});

const documentsOf = (
	tools: { name: string; description: string }[],
	namespaces: Record<string, { name: string; instructions?: string }> = {},
) =>
	tools.map((tool) =>
		createToolSearchDocument(
			{ ...tool, parameters: Type.Object({}) },
			namespaces[tool.name.split("__").slice(0, 2).join("__")],
		),
	);
const firstOf = (query: string, documents: ReturnType<typeof documentsOf>) =>
	new Bm25Ranker().rank(query, documents, 1).map((match) => match.name);

// pi#11331
test("tool search ranks a name match above mentions in descriptions", () => {
	const documents = documentsOf([
		{ name: "mcp__ci__status", description: "Deploy status: last deploy, deploy log, deploy errors." },
		{
			name: "mcp__ci__deploy_release",
			description:
				"Start a release of the current branch to an environment, run the migrations, switch traffic over, and wait until the new version is live and healthy.",
		},
	]);
	assert.deepEqual(firstOf("deploy", documents), ["mcp__ci__deploy_release"]);
});

// pi#11331
test("tool search ranks a tool first when the query contains its whole name", () => {
	const documents = documentsOf(
		[
			{
				name: "mcp__peekaboo__see",
				description: "Capture the app window of the peekaboo app and describe the app.",
			},
			{ name: "mcp__peekaboo__menu", description: "Click a menu item of an app." },
			{
				name: "mcp__peekaboo__app",
				description:
					"Launch, quit, relaunch, focus, hide, or switch applications. Targets an application by name, bundle identifier, or process ID, and can wait until it is ready.",
			},
			{ name: "mcp__app__queue_read", description: "Read a queued message of this thread." },
			{
				name: "mcp__dev-app__thread_read",
				description:
					"Read durable state and a paginated timeline from any thread. The default view returns user messages, assistant messages and plans.",
			},
		],
		{ mcp__peekaboo: { name: "mcp__peekaboo", instructions: "Peekaboo controls macOS apps by app name." } },
	);
	assert.deepEqual(firstOf("peekaboo app", documents), ["mcp__peekaboo__app"]);
	assert.deepEqual(firstOf("open the peekaboo app tool", documents), ["mcp__peekaboo__app"]);
	assert.deepEqual(firstOf("read thread_read state", documents), ["mcp__dev-app__thread_read"]);
	// Without the whole name, mentions in descriptions decide.
	assert.deepEqual(firstOf("describe window", documents), ["mcp__peekaboo__see"]);
});

// pi#11331
test("tool search ranks a tool matching more query terms first, whatever the scores", () => {
	const documents = documentsOf([
		{
			name: "mcp__peekaboo__app",
			description: "Launch, quit, focus, or switch applications by name or bundle identifier.",
		},
		{ name: "mcp__peekaboo__see", description: "Capture the app window and describe the UI elements of the app." },
		{ name: "mcp__peekaboo__window", description: "Move, resize, or close a window of an app." },
		{ name: "mcp__peekaboo__image", description: "Take a screenshot of the screen, an app, or a window." },
	]);
	// `window` and `app` are whole names, but each covers one of the two terms.
	assert.deepEqual(firstOf("screenshot window", documents), ["mcp__peekaboo__image"]);
	assert.deepEqual(firstOf("describe app", documents), ["mcp__peekaboo__see"]);
	// An exact name still ranks first.
	assert.deepEqual(firstOf("window", documents), ["mcp__peekaboo__window"]);
});

test("tool search searches the namespace text, which does not lower a server's tools for long instructions", () => {
	const documents = documentsOf(
		[
			{ name: "mcp__x__run", description: "Run it." },
			{ name: "mcp__y__stop", description: "Stop it." },
		],
		{ mcp__x: { name: "mcp__x", instructions: "Kubernetes cluster tools" } },
	);
	assert.deepEqual(firstOf("kubernetes", documents), ["mcp__x__run"]);

	// Instructions are a separate field: the description alone is length-normalized.
	const short = documentsOf([
		{ name: "mcp__z__go", description: "Go there now." },
		...documents.map(() => ({ name: "mcp__w__n", description: "N." })),
	]);
	const long = documentsOf(
		[
			{ name: "mcp__z__go", description: "Go there now." },
			...documents.map(() => ({ name: "mcp__w__n", description: "N." })),
		],
		{ mcp__z: { name: "mcp__z", instructions: "Lorem ipsum ".repeat(500) } },
	);
	const ranker = new Bm25Ranker();
	assert.equal(ranker.rank("go there", long, 1)[0]!.score, ranker.rank("go there", short, 1)[0]!.score);
});

test("tool search tokenizes words in any script, with identifier boundaries and canonical equivalence (pi#10816)", () => {
	assert.deepEqual(tokenize("repo.issues/search:queries"), ["repo", "issue", "search", "query"]);
	for (const [text, expected] of [
		["搜索仓库问题", ["搜索", "仓库", "问题"]],
		["文書を検索", ["文書", "を", "検索"]],
		["문서 검색", ["문서", "검색"]],
		["ค้นหาเอกสาร", ["ค้นหา", "เอกสาร"]],
		["Поиск документов", ["поиск", "документов"]],
		["البحث عن الملفات", ["البحث", "عن", "الملفات"]],
		["फ़ाइल खोजें", ["फ़ाइल", "खोजें"]],
		["Éléments cafés", ["éléments", "cafés"]],
	] as const) {
		assert.deepEqual(tokenize(text), expected, text);
	}
	// Mixed-language identifiers split at the script boundary and at camelCase.
	assert.deepEqual(tokenize("搜索GitHub_repoIssues"), ["搜索", "git", "hub", "repo", "issue"]);
	assert.deepEqual(tokenize("CAFÉ cafe\u0301"), ["café", "café"]);
	assert.deepEqual(tokenize(" \t，。!? 😀 "), []);
});

test("tool search matches non-ASCII queries against non-ASCII descriptions (pi#10816)", () => {
	for (const [description, query] of [
		["搜索仓库问题", "问题"],
		["文書を検索", "検索"],
		["문서 검색", "검색"],
		["ค้นหาเอกสาร", "เอกสาร"],
		["Поиск документов", "документов"],
		["البحث عن الملفات", "الملفات"],
		["फ़ाइल खोजें", "खोजें"],
		["Rechercher un café", "cafe\u0301"],
	] as const) {
		const documents = documentsOf([
			{ name: "mcp__app__read", description: "Read a thread." },
			{ name: "localized", description },
		]);
		assert.deepEqual(firstOf(query, documents), ["localized"], query);
	}
	assert.deepEqual(
		new Bm25Ranker().rank("未知", documentsOf([{ name: "mcp__app__read", description: "Read a thread." }]), 8),
		[],
	);
});
