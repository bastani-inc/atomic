import assert from "node:assert/strict";
import { test } from "vitest";
import { planMorphRanges } from "../src/core/compaction/morph-compaction.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";

const parameters = { query: "fix login", compression_ratio: 0.5, preserve_recent: 2 };
const region = createNumberedRegion("[User]: task\na\n[Tool result]: old\nb\nc");

test("Morph sends structured messages and maps ranges while dropping invalid records (#3470)", async () => {
	const diagnostics: { droppedRangeCount: number; acceptedRangeCount: number }[] = [];
	const protectedRegion = { ...region, protectedLineNumbers: new Set([4]) };
	const ranges = await planMorphRanges(protectedRegion, parameters, {
		apiKey: "secret",
		fetchFn: async (url, options) => {
			assert.equal(url, "https://api.morphllm.com/v1/compact");
			assert.equal(options?.method, "POST");
			assert.deepEqual(options?.headers, { Authorization: "Bearer secret", "Content-Type": "application/json" });
			assert.deepEqual(JSON.parse(String(options?.body)), {
				messages: [
					{ role: "user", content: "[User]: task\na" },
					{ role: "tool", content: "[Tool result]: old\nb\nc" },
				],
				query: "fix login",
				compression_ratio: 0.5,
				preserve_recent: 0,
				include_markers: false,
			});
			return Response.json({
				messages: [
					{
						content: "ignore substituted text",
						compacted_line_ranges: [
							{ start: 2, end: 2 },
							{ start: 0, end: 1 },
						],
					},
					{
						compacted_line_ranges: [
							{ start: 1, end: 3 },
							{ start: 3, end: 4 },
							{ start: 1.5, end: 2 },
							{ start: 2, end: 1 },
						],
					},
				],
			});
		},
		onDiagnostics: (value) => diagnostics.push(value),
	});
	assert.deepEqual(Array.from(ranges), [
		{ start: 2, end: 3 },
		{ start: 5, end: 5 },
	]);
	assert.deepEqual(diagnostics, [{ droppedRangeCount: 4, acceptedRangeCount: 2 }]);
});

test("Morph fails closed on missing credentials, HTTP errors, malformed responses and no usable ranges (#3470)", async () => {
	await assert.rejects(
		planMorphRanges(region, parameters, {
			apiKey: undefined,
			fetchFn: async () => {
				assert.fail("no request without key");
			},
		}),
		/MORPH_API_KEY/,
	);
	for (const response of [
		new Response("unavailable", { status: 503 }),
		Response.json({ messages: [] }),
		Response.json({ messages: [{ compacted_line_ranges: [] }, { compacted_line_ranges: [] }] }),
		Response.json({ messages: [{ compacted_line_ranges: "bad" }, {}] }),
	]) {
		await assert.rejects(
			planMorphRanges(region, parameters, { apiKey: "secret", fetchFn: async () => response }),
			/Morph/,
		);
	}
});

test("Morph passes cancellation through fetch (#3470)", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		planMorphRanges(region, parameters, {
			apiKey: "secret",
			signal: controller.signal,
			fetchFn: async () => {
				assert.fail("cancelled request");
			},
		}),
		/cancelled/,
	);
});
