import assert from "node:assert/strict";
import type { ExtensionAPI } from "@bastani/atomic";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";

interface StoredData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: object[];
	urls?: Array<{ content: string }>;
}

interface SearchReturnModule {
	buildSearchReturn(
		options: {
			queryList: string[];
			results: Array<{ query: string; answer: string; results: Array<{ title: string; url: string }>; error: null }>;
			urls: string[];
			includeContent: boolean;
			inlineContent?: Array<{ url: string; title: string; content: string; error: null }>;
		},
		deps: {
			pi: ExtensionAPI;
			storage: { storeResult(id: string, data: StoredData): void };
			startBackgroundFetch(urls: string[]): string | null;
		},
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: { queries: string[]; searchId: string; fetchId: string | null };
	}>;
}

const { buildSearchReturn } = await vi.importActual<SearchReturnModule>(
	"../../packages/web-access/web-search-return.js",
);

const options = {
	queryList: ["raw query", "raw query"],
	results: [
		{ query: "raw query", answer: "answer", results: [{ title: "title", url: "https://example.test" }], error: null },
	],
	urls: ["https://example.test"],
	includeContent: false,
} satisfies Parameters<SearchReturnModule["buildSearchReturn"]>[0];

test("search results and inline content become available only after their session commits", async () => {
	let commit: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		commit = resolve;
	});
	let appendStarted: () => void = () => {};
	const appending = new Promise<void>((resolve) => {
		appendStarted = resolve;
	});
	const committed: StoredData[] = [];
	const published: StoredData[] = [];
	const api: Pick<ExtensionAPI, "appendEntry"> = {
		async appendEntry(_type, data) {
			appendStarted();
			await pending;
			committed.push(data as StoredData);
		},
	};
	const completion = buildSearchReturn(
		{
			...options,
			inlineContent: [{ url: options.urls[0], title: "title", content: "raw content\n", error: null }],
		},
		{
			pi: api as ExtensionAPI,
			storage: {
				storeResult(_id, data) {
					assert.ok(committed.includes(data));
					published.push(data);
				},
			},
			startBackgroundFetch: () => null,
		},
	);
	await appending;
	assert.equal(published.length, 0);
	commit();
	const result = await completion;
	assert.deepEqual(
		published.map((data) => data.type),
		["fetch", "search"],
	);
	assert.equal(result.details.fetchId, published[0].id);
	assert.equal(result.details.searchId, published[1].id);
	assert.equal(result.details.queries, options.queryList);
	assert.equal(published[1].queries, options.results);
	assert.equal(published[0].urls?.[0].content, "raw content\n");
});

test("a rejected search-result commit preserves the typed failure and publishes no result", async () => {
	const failure = new StorageUnavailableError({ adapter: "test", location: "search" }, new Error("write failed"));
	let published = false;
	const api: Pick<ExtensionAPI, "appendEntry"> = {
		async appendEntry() {
			throw failure;
		},
	};
	await assert.rejects(
		buildSearchReturn(options, {
			pi: api as ExtensionAPI,
			storage: {
				storeResult() {
					published = true;
				},
			},
			startBackgroundFetch: () => null,
		}),
		(error: Error) => {
			assert.equal(error, failure);
			return true;
		},
	);
	assert.equal(published, false);
});
