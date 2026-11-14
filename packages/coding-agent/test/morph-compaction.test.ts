import assert from "node:assert/strict";
import { test } from "vitest";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
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

test("Morph HTTP errors retain bounded credential-free body details in errors and diagnostics (#3470)", async () => {
	const diagnostics: string[] = [];
	const apiKey = "opaque-morph-credential";
	const body =
		`Quota exceeded for ${apiKey}. Authorization: Bearer opaque-bearer\n` +
		`{"api_key":"other-opaque-key","password":"private-password"}\n` +
		`sk-abcdefghijklmnop ${"detail ".repeat(200)} END-OF-BODY`;
	await assert.rejects(
		planMorphRanges(region, parameters, {
			apiKey,
			fetchFn: async () => new Response(body, { status: 429 }),
			onDiagnostics: (diagnostic) => diagnostics.push(JSON.stringify(diagnostic)),
		}),
		(error: Error) => {
			assert.match(error.message, /Morph compaction HTTP 429: Quota exceeded/);
			assert.ok(error.message.length <= 550);
			assert.doesNotMatch(
				error.message,
				/opaque-morph-credential|opaque-bearer|other-opaque-key|private-password|sk-abcdefghijklmnop|END-OF-BODY/,
			);
			return true;
		},
	);
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0], /Morph compaction HTTP 429: Quota exceeded/);
	assert.match(diagnostics[0], /provider_error/);
	assert.doesNotMatch(
		diagnostics[0],
		/opaque-morph-credential|opaque-bearer|other-opaque-key|private-password|sk-abcdefghijklmnop|END-OF-BODY/,
	);
});

test("Morph bounds HTTP error body reads and does not expose a credential cut by the read cap (#3470)", async () => {
	let reads = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			reads++;
			const chunk =
				reads === 1 ? `Service unavailable\n${"x".repeat(8100)} {"api_key":"cut-secret` : "cut-secret".repeat(2000);
			controller.enqueue(new TextEncoder().encode(chunk));
			if (reads === 10) controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	await assert.rejects(
		planMorphRanges(region, parameters, { apiKey: "key", fetchFn: async () => new Response(body, { status: 503 }) }),
		(error: Error) => {
			assert.match(error.message, /HTTP 503: Service unavailable/);
			assert.doesNotMatch(error.message, /cut-secret/);
			return true;
		},
	);
	assert.equal(cancelled, true);
	assert.ok(reads < 10);
});

/** A stand-in for Morph: it force-keeps tagged spans and deletes other lines until the ratio of all lines is met. */
function fakeMorph(extraKept = 0): typeof fetch {
	return async (_url, options) => {
		const request: { messages: { content: string }[]; compression_ratio: number } = JSON.parse(String(options?.body));
		const messages = request.messages.map((message) => message.content.split("\n"));
		const tagged = messages.map((lines) => {
			const kept = new Set<number>();
			let open: number | undefined;
			lines.forEach((line, index) => {
				const body = line.replace(/^\[(User|Assistant|Tool result)\]: /, "");
				if (body === "<keepContext>") open ??= index + 1;
				if (body === "</keepContext>" && open !== undefined) {
					for (let kept_ = open; kept_ <= index + 1; kept_++) kept.add(kept_);
					open = undefined;
				}
			});
			return kept;
		});
		const total = messages.reduce((sum, lines) => sum + lines.length, 0);
		let keep = total;
		const target = Math.round(total * request.compression_ratio);
		const deleted = messages.map((lines, index) =>
			lines.map((_, line) => {
				if (keep <= target || tagged[index].has(line + 1)) return false;
				keep--;
				return true;
			}),
		);
		return Response.json({
			messages: deleted.map((flags, index) => ({
				compacted_line_ranges: flags.flatMap((flag, line) => (flag ? [{ start: line + 1, end: line + 1 }] : [])),
				kept_line_ranges: [
					...[...tagged[index]].map((line) => ({ start: line, end: line })),
					...(index === 0 && extraKept > 0
						? [{ start: messages[0].length - extraKept + 1, end: messages[0].length }]
						: []),
				],
			})),
		});
	};
}

test("Morph receives released spans and tool-result tags untagged, protected spans tagged, and meets the keep target (#4794)", async () => {
	const lines = [
		"[User]: <keepContext>",
		"released constraint",
		"</keepContext>",
		...Array.from({ length: 6 }, (_, index) => `brief ${index}`),
		"[Assistant]: <keepContext>",
		"pinned decision",
		"</keepContext>",
		...Array.from({ length: 6 }, (_, index) => `work ${index}`),
		"[Tool result]: <keepContext>",
		"fetched payload",
		"</keepContext>",
	];
	// Atomic released the first span; only the assistant's stays protected.
	const target = { ...createNumberedRegion(lines.join("\n")), protectedLineNumbers: new Set([10, 11, 12]) };
	let sent: { messages: { content: string }[]; compression_ratio: number } | undefined;
	const morph = fakeMorph();
	const diagnostics: { droppedRangeCount: number; protectedMismatchLineCount?: number }[] = [];
	const ranges = await planMorphRanges(
		target,
		{ query: "fix login", compression_ratio: 0.5, preserve_recent: 0 },
		{
			apiKey: "secret",
			fetchFn: async (url, options) => {
				sent = JSON.parse(String(options?.body));
				return morph(url, options);
			},
			onDiagnostics: (value) => diagnostics.push(value),
		},
	);
	assert.ok(sent);
	assert.deepEqual(
		sent.messages.map((message) => message.content.split("\n")),
		[
			["", "released constraint", "", ...Array.from({ length: 6 }, (_, index) => `brief ${index}`)],
			[
				"[Assistant]: <keepContext>",
				"pinned decision",
				"</keepContext>",
				...Array.from({ length: 6 }, (_, index) => `work ${index}`),
			],
			["", "fetched payload", ""],
		],
	);
	// Morph counts force-kept lines against its ratio, so the region's own ratio already meets the target.
	assert.equal(sent.compression_ratio, 0.5);
	const result = reconstructCompactedTranscript(target, validateDeletedRanges(ranges, target));
	assert.ok(result.stats.linesKept <= Math.round(lines.length * 0.5), `kept ${result.stats.linesKept}`);
	assert.ok(result.text.includes("pinned decision"));
	assert.ok(!result.text.includes("released constraint"));
	// Morph's force-kept lines match Atomic's protected lines, so no mismatch is recorded.
	assert.equal(diagnostics[0].droppedRangeCount, 0);
	assert.equal("protectedMismatchLineCount" in diagnostics[0], false);

	const mismatched: { protectedMismatchLineCount?: number }[] = [];
	await planMorphRanges(
		target,
		{ query: "fix login", compression_ratio: 0.5, preserve_recent: 0 },
		{ apiKey: "secret", fetchFn: fakeMorph(2), onDiagnostics: (value) => mismatched.push(value) },
	);
	assert.equal(mismatched[0].protectedMismatchLineCount, 2);
});
