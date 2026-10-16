import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";

interface WebSearchConfig {
	shortcuts?: {
		curate?: string;
		activity?: string;
	};
}

interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

interface SearchReturnOptions {
	queryList: string[];
	results: Array<{ query: string }>;
	urls: string[];
	includeContent: boolean;
}

interface SearchReturnPayload {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, string | null>;
}

type SearchReturnBuilder = (opts: SearchReturnOptions) => Promise<SearchReturnPayload>;

interface WebSearchFeaturesModule {
	registerWebSearchFeatures(pi: ExtensionAPI, initConfig: WebSearchConfig): void;
}

type EventHandler = (event: object, ctx: ExtensionContext) => Promise<void> | void;

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

interface MessageObservation {
	customType: string;
	content: string | undefined;
	triggerTurn: boolean | undefined;
}

interface RegisteredState {
	fetchAllContent: ReturnType<typeof vi.fn>;
	handlers: Map<string, EventHandler>;
	buildReturn: SearchReturnBuilder | null;
	messages: MessageObservation[];
	fetchSignal: AbortSignal | null;
	nextFetchId: number;
}

const state = vi.hoisted(
	(): RegisteredState => ({
		fetchAllContent: vi.fn(),
		handlers: new Map(),
		buildReturn: null,
		messages: [],
		fetchSignal: null,
		nextFetchId: 0,
	}),
);

vi.mock("../../packages/web-access/extract.js", () => ({
	fetchAllContent: state.fetchAllContent,
}));

vi.mock("../../packages/web-access/github-extract.js", () => ({
	clearCloneCache: vi.fn(),
}));

vi.mock("../../packages/web-access/content-tools.js", () => ({
	registerContentTools: vi.fn(),
}));

vi.mock("../../packages/web-access/storage.js", () => ({
	generateId: () => `fetch-${++state.nextFetchId}`,
	createResultStorage: () => ({ clearResults: vi.fn(), restoreFromSession: vi.fn(), storeResult: vi.fn() }),
}));

vi.mock("../../packages/web-access/web-search-activity.js", () => ({
	createActivityWidgetState: () => ({}),
	refreshActivityForSession: vi.fn(),
	shutdownActivityWidget: vi.fn(),
	toggleActivityWidget: vi.fn(),
}));

vi.mock("../../packages/web-access/web-search-curator.js", () => ({
	openCuratorBrowser: vi.fn(async () => {}),
}));

vi.mock("../../packages/web-access/web-search-formatting.js", () => ({
	MAX_INLINE_CONTENT: 10_000,
	formatFullResults: vi.fn(),
	stripThumbnails: (results: ExtractedContent[]) => results,
}));

vi.mock("../../packages/web-access/web-search-config.js", () => ({
	DEFAULT_SHORTCUTS: { curate: "ctrl-c", activity: "ctrl-a" },
}));

vi.mock("../../packages/web-access/web-search-command.js", () => ({
	registerWebSearchCommand: vi.fn(),
}));

vi.mock("../../packages/web-access/web-search-tool.js", () => ({
	registerWebSearchTool: (_pi: ExtensionAPI, deps: { buildSearchReturn: SearchReturnBuilder }) => {
		state.buildReturn = deps.buildSearchReturn;
	},
}));

vi.mock("../../packages/web-access/web-search-return.js", () => ({
	buildSearchReturn: async (
		_opts: SearchReturnOptions,
		deps: { startBackgroundFetch(urls: string[]): string | null },
	): Promise<SearchReturnPayload> => {
		const fetchId = deps.startBackgroundFetch(["https://example.test/article"]);
		return {
			content: [{ type: "text", text: "background fetch started" }],
			details: { fetchId },
		};
	},
}));

const { registerWebSearchFeatures } = await vi.importActual<WebSearchFeaturesModule>(
	"../../packages/web-access/web-search-features.js",
);

function deferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function createPi(
	options: { appendError?: Error; appendCommit?: Promise<void>; contentAdmission?: Promise<void> } = {},
): ExtensionAPI {
	const on = (event: string, handler: EventHandler): void => {
		state.handlers.set(event, handler);
	};
	const appendEntry = async (_customType: string, _data: Record<string, string | number | null>): Promise<void> => {
		await options.appendCommit;
		if (options.appendError) throw options.appendError;
	};
	const sendMessage = (
		message: { customType: string; content?: string },
		sendOptions?: { triggerTurn?: boolean },
	): void | Promise<void> => {
		state.messages.push({
			customType: message.customType,
			content: message.content,
			triggerTurn: sendOptions?.triggerTurn,
		});
		if (message.customType === "web-search-content-ready") return options.contentAdmission;
		return undefined;
	};
	// The supplied members stay structurally checked against ExtensionAPI; the
	// single widening cast sits at the return boundary because the production
	// signature demands the full interface (Greptile P2 on PR #2312).
	const fixture: Pick<
		ExtensionAPI,
		"on" | "registerShortcut" | "registerTool" | "registerCommand" | "appendEntry" | "sendMessage"
	> = {
		// Member-scoped casts for the three members whose production signatures
		// are overloaded/generic; the simplified doubles cannot satisfy them
		// structurally, and the narrowing made that visible (it was hidden by
		// the blanket unknown cast). Every other member stays fully checked.
		on: on as ExtensionAPI["on"],
		registerShortcut: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: appendEntry as ExtensionAPI["appendEntry"],
		sendMessage: sendMessage as ExtensionAPI["sendMessage"],
	};
	return fixture as ExtensionAPI;
}

function setup(options: Parameters<typeof createPi>[0] = {}): ExtensionAPI {
	state.fetchAllContent.mockReset();
	state.fetchSignal = null;
	state.handlers.clear();
	state.buildReturn = null;
	state.messages.length = 0;
	state.nextFetchId = 0;
	state.fetchAllContent.mockImplementation((_urls: string[], signal: AbortSignal) => {
		state.fetchSignal = signal;
		return Promise.resolve([
			{
				url: "https://example.test/article",
				title: "Example",
				content: "Example content",
				error: null,
			},
		] satisfies ExtractedContent[]);
	});
	const pi = createPi(options);
	registerWebSearchFeatures(pi, {} as WebSearchConfig);
	return pi;
}

async function startSession(): Promise<void> {
	const handler = state.handlers.get("session_start");
	assert.ok(handler, "session_start handler should be registered");
	await handler({}, {} as ExtensionContext);
}

async function shutdownSession(): Promise<void> {
	const handler = state.handlers.get("session_shutdown");
	assert.ok(handler, "session_shutdown handler should be registered");
	await handler({}, {} as ExtensionContext);
}

async function waitForNotifications(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function buildBackgroundFetch(): Promise<SearchReturnPayload> {
	assert.ok(state.buildReturn, "web search return builder should be registered");
	const options: SearchReturnOptions = {
		queryList: ["example"],
		results: [],
		urls: ["https://example.test/article"],
		includeContent: true,
	};
	return state.buildReturn(options);
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(async () => {
	if (state.handlers.has("session_shutdown")) await shutdownSession();
});

test("a non-stale appendEntry failure posts a visible web-search-error entry", async () => {
	setup({
		appendError: new StorageUnavailableError({ adapter: "test", location: "test" }, new Error("append failed")),
	});
	await startSession();

	await buildBackgroundFetch();
	await waitForNotifications();

	assert.deepEqual(state.messages, [
		{
			customType: "web-search-error",
			content: "Content fetch failed [fetch-1]: Storage unavailable: test at test",
			triggerTurn: false,
		},
	]);
});

test("a stale appendEntry failure is contained without posting a web-search-error entry", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	setup({ appendError: new Error(STALE_EXTENSION_CONTEXT_MESSAGE) });
	await startSession();

	await buildBackgroundFetch();
	await waitForNotifications();

	assert.deepEqual(state.messages, []);
	assert.equal(errorSpy.mock.calls.length, 0);
});

test("content-ready notification waits for the search-result commit", async () => {
	const commit = deferred<void>();
	setup({ appendCommit: commit.promise });
	await startSession();
	await buildBackgroundFetch();
	await waitForNotifications();
	assert.equal(state.messages.length, 0);
	commit.resolve();
	await waitForNotifications();
	assert.equal(state.messages[0]?.customType, "web-search-content-ready");
});

test("a fetch whose commit finishes after session shutdown does not notify the retired session", async () => {
	const commit = deferred<void>();
	setup({ appendCommit: commit.promise });
	await startSession();
	await buildBackgroundFetch();
	await waitForNotifications();
	await shutdownSession();
	commit.resolve();
	await waitForNotifications();
	assert.deepEqual(state.messages, []);
});

test("pending fetch cleanup waits for content-ready message admission", async () => {
	const admission = deferred<void>();
	setup({ contentAdmission: admission.promise });
	await startSession();

	await buildBackgroundFetch();
	await waitForNotifications();
	assert.equal(state.messages[0]?.customType, "web-search-content-ready");
	assert.ok(state.fetchSignal, "fetch signal should be captured");

	await shutdownSession();
	assert.equal(state.fetchSignal.aborted, true);

	admission.resolve();
	await waitForNotifications();
});

// #3105: shutdown authority belongs to one instance even while notification admission is suspended.
test("sibling shutdown preserves a pending fetch until its own owner closes", async () => {
	const admission = deferred<void>();
	setup({ contentAdmission: admission.promise });
	await startSession();
	const firstShutdown = state.handlers.get("session_shutdown")!;
	await buildBackgroundFetch();
	await waitForNotifications();
	const firstSignal = state.fetchSignal!;
	assert.equal(firstSignal.aborted, false);

	registerWebSearchFeatures(createPi(), {});
	await startSession();
	await shutdownSession();
	assert.equal(firstSignal.aborted, false, "sibling retired another owner's admitted fetch");
	await firstShutdown({}, {} as ExtensionContext);
	assert.equal(firstSignal.aborted, true);
	admission.resolve();
	await waitForNotifications();
});
