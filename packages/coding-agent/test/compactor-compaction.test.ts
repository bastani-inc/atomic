import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai";
import { afterEach, describe, it, vi } from "vitest";
import { COMPACTOR_REQUEST_TIMEOUT_MS } from "../src/core/compaction/compactor.ts";
import {
	buildCompactorMessages,
	CompactionCancelledError,
	CompactionError,
	CompactorFailure,
	estimateContextTokens,
	requestCompactorOutput,
	wrapLongLines,
} from "../src/core/compaction/index.ts";
import { convertToLlm, createCustomMessage, createVerbatimCompactionMessage } from "../src/core/messages.ts";
import { createHistoryRouter } from "../src/core/tools/history-protocol.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const API_KEY = "sk-morph-secret-key-0123456789";

function writeModelsJson(dir: string, providers: Record<string, object>): string {
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify({ providers }));
	return path;
}
const COMPACTOR = "morph/morph-compactor";

interface CapturedRequest {
	url: string;
	authorization: string | null;
	body: {
		messages: Array<{ role: string; content: string }>;
		query: string;
		compression_ratio: number;
		preserve_recent: number;
		include_markers: boolean;
		model: string;
	};
}

function endpoint(respond: (request: CapturedRequest) => Response | Promise<Response>): {
	fetch: typeof fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const request: CapturedRequest = {
			url: String(input),
			authorization: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(String(init?.body)),
		};
		requests.push(request);
		if (init?.signal?.aborted) throw init.signal.reason;
		return respond(request);
	}) as typeof fetch;
	return { fetch: fake, requests };
}

function json(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function conversation(): AgentMessage[] {
	return [
		createVerbatimCompactionMessage("earlier compacted text", 100, new Date(0).toISOString(), {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters: { query: "q" },
			stats: {
				linesBefore: 1,
				linesDeleted: 0,
				linesKept: 1,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 10,
				percentReduction: 90,
			},
			form: "cleared",
		}),
		{
			role: "user",
			content: [
				{ type: "text", text: "look at this screenshot" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: 1,
		},
		{
			...fauxAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "I will read the file." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
			]),
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "ENOENT: no such file" }],
			isError: true,
			timestamp: 3,
		},
		{
			role: "bashExecution",
			command: "npm test",
			output: "1 failing",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: 4,
		},
		createCustomMessage("intercom", "steer: keep the API stable", true, undefined, new Date(5).toISOString()),
	];
}

describe("compactor request framing", () => {
	it("frames every message kind, puts earlier compacted text first, omits images and thinking", () => {
		const messages = buildCompactorMessages(
			conversation(),
			(message) => message.role === "custom" && message.customType === "compaction",
		);
		const contents = messages.map((message) => message.content);
		assert.ok(
			contents[0].startsWith(
				"<keepContext>\n[Previously compacted history]\n</keepContext>\nearlier compacted text",
			),
		);
		const all = contents.join("\n---\n");
		for (const label of [
			"[User]",
			"[Image omitted from text compaction (image/png)]",
			"[Assistant]",
			"[Tool call: read]",
			"path:\nsrc/app.ts",
			"[Tool result: read (error)]",
			"[Shell execution]",
			"$ npm test",
			"Exit code: 1",
			"[Extension context: intercom]",
		]) {
			assert.ok(all.includes(label), `missing ${label}:\n${all}`);
		}
		assert.ok(!all.includes("private reasoning"), "thinking is not sent");
		assert.ok(!all.includes("aGVsbG8="), "image data is not sent");
		assert.deepEqual(
			messages.map((message) => message.role),
			["user", "user", "assistant", "user", "user", "user"],
		);
	});

	it("sends only what the model sees: messages kept out of context are not framed", () => {
		const hidden = createCustomMessage(
			"workflow-heartbeat",
			"UI-ONLY",
			true,
			undefined,
			new Date(0).toISOString(),
			true,
		);
		const hiddenShell: AgentMessage = {
			role: "bashExecution",
			command: "echo HIDDEN-SHELL",
			output: "HIDDEN-SHELL",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 2,
			excludeFromContext: true,
		};
		const messages = buildCompactorMessages([...conversation(), hidden, hiddenShell], () => false);
		const all = messages.map((message) => message.content).join("\n");
		assert.ok(!all.includes("UI-ONLY"), all);
		assert.ok(!all.includes("HIDDEN-SHELL"), all);
		assert.ok(all.includes("[Extension context: intercom]"), "visible custom messages are still sent");
	});

	it("wraps very long lines without losing characters", () => {
		const line = "x".repeat(4_500);
		const wrapped = wrapLongLines(line, 2_000).split("\n");
		assert.deepEqual(
			wrapped.map((part) => part.length),
			[2_000, 2_000, 500],
		);
		assert.equal(wrapped.join(""), line);
	});
});

describe("compactor endpoint", () => {
	it("sends the framed messages, query, and model without hard-coded API params unless configured, and returns the output", async () => {
		const fake = endpoint(() => json({ output: "compacted text", usage: { input_tokens: 900, output_tokens: 300 } }));
		const result = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [{ role: "user", content: "hello" }],
			query: "fix the parser",
			signal: new AbortController().signal,
			fetchFn: fake.fetch,
		});
		assert.equal(result.text, "compacted text");
		assert.equal(result.usage?.input, 900);
		const [request] = fake.requests;
		assert.equal(request.url, "https://api.morphllm.com/v1/compact");
		assert.equal(request.authorization, `Bearer ${API_KEY}`);
		assert.deepEqual(request.body, {
			messages: [{ role: "user", content: "hello" }],
			query: "fix the parser",
			model: "morph-compactor",
		});
	});

	it("merges configured compactionParams into the request body", async () => {
		const fake = endpoint(() => json({ output: "compacted text" }));
		await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			params: { compression_ratio: 0.5, preserve_recent: 2, include_markers: true },
			messages: [{ role: "user", content: "hello" }],
			query: "fix the parser",
			signal: new AbortController().signal,
			fetchFn: fake.fetch,
		});
		const [request] = fake.requests;
		assert.deepEqual(request.body, {
			compression_ratio: 0.5,
			preserve_recent: 2,
			include_markers: true,
			messages: [{ role: "user", content: "hello" }],
			query: "fix the parser",
			model: "morph-compactor",
		});
	});

	it("trims trailing slashes from the base URL in linear time", async () => {
		const post = async (baseUrl: string) => {
			const fake = endpoint(() => json({ output: "x" }));
			const started = performance.now();
			await requestCompactorOutput({
				apiKey: API_KEY,
				modelId: "morph-compactor",
				baseUrl,
				messages: [],
				query: "q",
				signal: new AbortController().signal,
				fetchFn: fake.fetch,
			});
			return { url: fake.requests[0].url, elapsedMs: performance.now() - started };
		};
		assert.equal((await post("https://api.morphllm.com/v1")).url, "https://api.morphllm.com/v1/compact");
		assert.equal((await post("https://api.morphllm.com/v1/")).url, "https://api.morphllm.com/v1/compact");
		const trailing = await post(`https://api.morphllm.com/v1${"/".repeat(100_000)}`);
		assert.equal(trailing.url, "https://api.morphllm.com/v1/compact");
		assert.ok(trailing.elapsedMs < 1_000, `took ${trailing.elapsedMs} ms`);
		const interior = `https://api.morphllm.com${"/".repeat(100_000)}v1`;
		const inner = await post(interior);
		assert.equal(inner.url, `${interior}/compact`);
		assert.ok(inner.elapsedMs < 1_000, `took ${inner.elapsedMs} ms`);
	});

	it("joins message outputs when the endpoint returns messages", async () => {
		const fake = endpoint(() => json({ messages: [{ content: "one" }, { content: "  " }, { content: "two" }] }));
		const result = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [],
			query: "q",
			signal: new AbortController().signal,
			fetchFn: fake.fetch,
		});
		assert.equal(result.text, "one\n\ntwo");
	});

	const failures: Array<[string, () => Response | Promise<Response>, RegExp, string | undefined, string]> = [
		[
			"an HTTP error",
			() => json({ error: { message: `bad key ${API_KEY}` } }, 401),
			/^HTTP 401/u,
			API_KEY,
			"http-error",
		],
		["empty output", () => json({ output: "   " }), /^empty output$/u, API_KEY, "empty-output"],
		[
			"a malformed response",
			() => new Response("not json", { status: 200 }),
			/^malformed response$/u,
			API_KEY,
			"malformed-response",
		],
		["no credentials", () => json({ output: "x" }), /^no credentials/u, undefined, "missing-credentials"],
	];
	for (const [name, respond, reason, key, expectedCode] of failures) {
		it(`reports ${name} as a failure that never contains the key`, async () => {
			const fake = endpoint(respond);
			const error = await requestCompactorOutput({
				apiKey: key,
				modelId: "morph-compactor",
				baseUrl: "https://api.morphllm.com/v1",
				messages: [],
				query: "q",
				signal: new AbortController().signal,
				fetchFn: fake.fetch,
			}).catch((caught: Error) => caught);
			assert.ok(error instanceof CompactorFailure, String(error));
			assert.ok(error instanceof CompactionError);
			assert.equal(error.code, expectedCode);
			assert.match(error.message, reason);
			assert.ok(!error.message.includes(API_KEY));
		});
	}

	const unreachable = (code: string, message: string): typeof fetch =>
		(async () => {
			throw new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
		}) as typeof fetch;

	it("names the network failure's cause instead of a bare 'fetch failed'", async () => {
		const error = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [],
			query: "q",
			signal: new AbortController().signal,
			fetchFn: unreachable("ENOTFOUND", "getaddrinfo ENOTFOUND api.morphllm.com"),
			resolveHost: async () => ["104.18.28.116"],
		}).catch((caught: Error) => caught);
		assert.ok(error instanceof CompactorFailure, String(error));
		assert.equal(error.code, "network-error");
		assert.equal(error.message, "fetch failed: getaddrinfo ENOTFOUND api.morphllm.com");
	});

	it("names a DNS filter when the endpoint's host resolves to a sinkhole address", async () => {
		const resolved: string[] = [];
		const error = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [],
			query: "q",
			signal: new AbortController().signal,
			fetchFn: unreachable("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "tlsv1 alert internal error"),
			resolveHost: async (hostname) => {
				resolved.push(hostname);
				return ["0.0.0.0", "::"];
			},
		}).catch((caught: Error) => caught);
		assert.ok(error instanceof CompactorFailure, String(error));
		assert.deepEqual(resolved, ["api.morphllm.com"]);
		assert.match(error.message, /^fetch failed: ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: tlsv1 alert internal error \(/u);
		assert.match(error.message, /api\.morphllm\.com resolves to 0\.0\.0\.0/u);
		assert.match(error.message, /allow api\.morphllm\.com in the resolver\)$/u);
		assert.ok(!error.message.includes(API_KEY));
	});

	it("times out with a bounded wait", async () => {
		const fake = endpoint(() => new Promise<Response>(() => {}));
		const hanging: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				void fake.fetch(input, { ...init, signal: undefined });
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			})) as typeof fetch;
		const error = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [],
			query: "q",
			signal: new AbortController().signal,
			timeoutMs: 20,
			fetchFn: hanging,
		}).catch((caught: Error) => caught);
		assert.ok(error instanceof CompactorFailure);
		assert.ok(error instanceof CompactionError);
		assert.equal(error.code, "timeout");
		assert.equal(error.retryable, true);
		assert.equal(error.timeoutMs, 20);
		assert.equal(error.message, "timed out after 20 ms");
	});

	it("an abort of the compaction itself is a cancel, not a failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await requestCompactorOutput({
			apiKey: API_KEY,
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1",
			messages: [],
			query: "q",
			signal: controller.signal,
			fetchFn: endpoint(() => json({ output: "x" })).fetch,
		}).catch((caught: unknown) => caught);
		assert.ok(error instanceof CompactionCancelledError);
		assert.ok(error instanceof CompactionError);
		assert.equal(error.code, "cancelled");
		assert.match(error.message, /Compaction cancelled/u);
	});
});

describe("compaction with a configured compactor model", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		vi.unstubAllGlobals();
		await harness?.cleanup();
		harness = undefined;
	});

	async function compactorHarness(credentials: boolean): Promise<Harness> {
		const created = await createHarness({
			settings: { compactionModel: COMPACTOR, retry: { enabled: false } },
		});
		if (credentials) await created.authStorage.modify("morph", async () => ({ type: "api_key", key: API_KEY }));
		created.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
		await created.session.prompt("fix the parser in src/parser.ts");
		return created;
	}

	it("the compactor's output replaces the context, followed by the recovery instructions", async () => {
		const fake = endpoint(() => json({ output: "[User] fix the parser\n(filtered 3 lines)" }));
		vi.stubGlobal("fetch", fake.fetch);
		harness = await compactorHarness(true);
		const calls = harness.faux.state.callCount;

		const result = await harness.session.compact();

		assert.equal(fake.requests.length, 1, "exactly one compactor call");
		assert.equal(harness.faux.state.callCount, calls, "no chat model call");
		assert.equal(fake.requests[0].body.query, "fix the parser in src/parser.ts");
		assert.equal(result.form, "compacted");
		assert.equal(result.backend, "compactor");
		assert.equal(result.model, COMPACTOR);
		const context = convertToLlm(harness.session.messages).filter((message) => message.role !== "system");
		assert.equal(context.length, 1);
		const text = result.compactedText;
		assert.ok(text.startsWith("Context compacted."), text);
		assert.ok(text.includes("<compacted-context>\n[User] fix the parser\n(filtered 3 lines)\n</compacted-context>"));
		assert.ok(text.includes(`history://sessions/${harness.session.sessionId}`));
		assert.ok(text.indexOf("</compacted-context>") < text.indexOf("Recover what you need"));
	});

	for (const [form, body] of [
		["output", { output: `notes ${API_KEY} end` }],
		["messages", { messages: [{ content: `first ${API_KEY}` }, { content: "second" }] }],
	] as const) {
		it(`never stores the key when the compactor echoes it in its ${form}`, async () => {
			vi.stubGlobal("fetch", endpoint(() => json(body)).fetch);
			harness = await compactorHarness(true);
			const result = await harness.session.compact();
			assert.equal(result.form, "compacted");
			assert.ok(result.compactedText.includes("[redacted]"), result.compactedText);
			const router = createHistoryRouter({
				cwd: process.cwd(),
				currentSessionId: harness.session.sessionId,
				sessionStore: () => harness?.sessionManager.getSessionStore(),
			});
			const history = String(await router.read?.(`history://sessions/${harness.session.sessionId}`));
			const everything = JSON.stringify({
				result,
				events: harness.events,
				entries: harness.sessionManager.getEntries(),
				messages: harness.session.messages,
			});
			assert.ok(!everything.includes(API_KEY), "the key reached a result, event, entry or message");
			assert.ok(!history.includes(API_KEY), "the key reached the session history");
		});
	}

	it("a message kept out of the model's context is not sent to the compactor", async () => {
		const fake = endpoint(() => json({ output: "compacted notes" }));
		vi.stubGlobal("fetch", fake.fetch);
		harness = await compactorHarness(true);
		await harness.session.sendCustomMessage(
			{ customType: "workflow-heartbeat", content: "UI-ONLY", display: true },
			{ excludeFromContext: true },
		);

		const result = await harness.session.compact();

		assert.equal(result.form, "compacted");
		assert.equal(fake.requests.length, 1);
		assert.ok(!JSON.stringify(fake.requests[0].body).includes("UI-ONLY"));
		assert.ok(!JSON.stringify(convertToLlm(harness.session.messages)).includes("UI-ONLY"));
	});

	const fallbacks: Array<[string, () => Response | Promise<Response>, RegExp, boolean]> = [
		["no credentials", () => json({ output: "unused" }), /failed: no credentials/u, false],
		["an HTTP error", () => json({ error: { message: `invalid key ${API_KEY}` } }, 503), /failed: HTTP 503/u, true],
		["empty output", () => json({ output: "" }), /failed: empty output/u, true],
		["a malformed response", () => new Response("not json", { status: 200 }), /failed: malformed response/u, true],
	];
	for (const [name, respond, reason, credentials] of fallbacks) {
		it(`falls back to clearing the context on ${name}, naming the reason and never the key`, async () => {
			const fake = endpoint(respond);
			vi.stubGlobal("fetch", fake.fetch);
			harness = await compactorHarness(credentials);
			const result = await harness.session.compact();
			assert.equal(result.form, "cleared");
			assert.match(result.fallbackReason ?? "", reason);
			assert.ok(result.compactedText.startsWith("Context cleared."));
			assert.ok(fake.requests.length <= 1, "at most one compactor call per boundary");
			const everything = JSON.stringify({
				result,
				events: harness.events,
				entries: harness.sessionManager.getEntries(),
			});
			assert.ok(!everything.includes(API_KEY), "the key leaked into a result, event or entry");
		});
	}

	it("falls back to clearing the context when the compactor request times out", async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((ms) => realTimeout(ms === COMPACTOR_REQUEST_TIMEOUT_MS ? 20 : ms));
		const fake = endpoint(() => new Promise<Response>(() => {}));
		vi.stubGlobal(
			"fetch",
			((input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					void fake.fetch(input, { ...init, signal: undefined });
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				})) as typeof fetch,
		);
		harness = await compactorHarness(true);
		const result = await harness.session.compact();
		assert.ok(
			timeout.mock.calls.some(([ms]) => ms === COMPACTOR_REQUEST_TIMEOUT_MS),
			"the bounded wait was used",
		);
		timeout.mockRestore();
		assert.equal(result.form, "cleared");
		assert.match(result.fallbackReason ?? "", /timed out after/u);
		assert.equal(fake.requests.length, 1);
	});

	async function budgetHarness(systemPrompt: string): Promise<Harness> {
		const created = await createHarness({
			models: [{ id: "budget", contextWindow: 32_000, maxTokens: 1_000 }],
			resourceLoader: createTestResourceLoader({ systemPrompt }),
			settings: {
				compactionModel: COMPACTOR,
				compaction: { enabled: true, reserveTokens: 1_000 },
				retry: { enabled: false },
			},
		});
		await created.authStorage.modify("morph", async () => ({ type: "api_key", key: API_KEY }));
		created.setResponses([fauxAssistantMessage("answer")]);
		await created.session.prompt("fix the parser");
		return created;
	}

	const ACME_COMPACTOR = {
		id: "c1",
		name: "Acme Compactor",
		type: "compactor" as const,
		api: "custom-compact",
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const loadingPaths: Array<[string, string, (dir: string) => Partial<Parameters<typeof createHarness>[0]>]> = [
		["the built-in catalog entry", COMPACTOR, () => ({})],
		[
			"a models.json compactor without maxTokens",
			"acme/c1",
			(dir) => ({
				modelsPath: writeModelsJson(dir, {
					acme: { baseUrl: "https://compact.example.com/v1", apiKey: API_KEY, models: [ACME_COMPACTOR] },
				}),
			}),
		],
		[
			"an extension's compactor without maxTokens",
			"acme/c1",
			() => ({
				extensionFactories: [
					(atomic) => {
						atomic.registerProvider("acme", {
							baseUrl: "https://compact.example.com/v1",
							apiKey: API_KEY,
							models: [ACME_COMPACTOR],
						});
					},
				],
			}),
		],
		[
			"a models.json override of the built-in entry without maxTokens",
			COMPACTOR,
			(dir) => ({
				modelsPath: writeModelsJson(dir, {
					morph: { modelOverrides: { "morph-compactor": { compactionParams: { compression_ratio: 0.5 } } } },
				}),
			}),
		],
	];
	for (const [path, compactionModel, configure] of loadingPaths) {
		it(`keeps a long output whole from ${path} on a model with a large context window`, async () => {
			const output = "word ".repeat(220_000);
			vi.stubGlobal("fetch", endpoint(() => json({ output })).fetch);
			const dir = mkdtempSync(join(tmpdir(), "atomic-compactor-paths-"));
			try {
				const created = await createHarness({
					models: [{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 }],
					settings: { compactionModel, retry: { enabled: false } },
					...configure(dir),
				});
				harness = created;
				await created.authStorage.modify("morph", async () => ({ type: "api_key", key: API_KEY }));
				created.setResponses([fauxAssistantMessage("answer")]);
				await created.session.prompt("fix the parser");
				const [provider, id] = compactionModel.split("/");
				const model = created.session.modelRuntime
					.getModelsOfType("compactor")
					.find((entry) => entry.provider === provider && entry.id === id);
				assert.ok(model, `${compactionModel} is registered`);
				assert.equal(model.maxTokens, undefined);
				if (path.includes("override")) assert.deepEqual(model.compactionParams, { compression_ratio: 0.5 });

				const result = await created.session.compact();

				assert.equal(result.form, "compacted");
				assert.equal(result.fallbackReason, undefined);
				assert.equal(result.model, compactionModel);
				assert.ok(result.compactedText.includes(`<compacted-context>\n${output.trimEnd()}`));
				assert.ok(estimateContextTokens(created.session.messages).tokens > 270_000);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("keeps the compactor's output even when the replacement does not fit below the trigger", async () => {
		vi.stubGlobal("fetch", endpoint(() => json({ output: "word ".repeat(12_400) })).fetch);
		harness = await budgetHarness("rule ".repeat(16_000));
		const result = await harness.session.compact();
		assert.equal(result.form, "compacted");
		assert.equal(result.fallbackReason, undefined);
		assert.ok(result.compactedText.includes("word word"));
	});

	it("a maxTokens the compactor model's configuration sets is the only limit on its output", async () => {
		vi.stubGlobal("fetch", endpoint(() => json({ output: "word ".repeat(4_000) })).fetch);
		harness = await compactorHarness(false);
		const limited = (maxTokens: number) => ({
			id: `limited-${maxTokens}`,
			name: "Limited compactor",
			type: "compactor" as const,
			api: "custom-compact",
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens,
		});
		harness.session.modelRuntime.registerProvider("acme", {
			baseUrl: "https://compact.example.com/v1",
			apiKey: API_KEY,
			models: [limited(1_000), limited(10_000)],
		});

		const over = await harness.session.compact({ compactionModel: "acme/limited-1000" });
		assert.equal(over.form, "cleared");
		assert.equal(over.fallbackReason, "acme/limited-1000 failed: output too long (5000 > 1000 tokens)");
		await harness.session.prompt("keep going");

		const under = await harness.session.compact({ compactionModel: "acme/limited-10000" });
		assert.equal(under.form, "compacted");
		assert.equal(under.fallbackReason, undefined);
	});

	it("keeps a compactor's output that is larger than the automatic trigger", async () => {
		vi.stubGlobal("fetch", endpoint(() => json({ output: "word ".repeat(40_000) })).fetch);
		harness = await budgetHarness("rules");
		const result = await harness.session.compact();
		assert.equal(result.form, "compacted");
		assert.equal(result.fallbackReason, undefined);
		assert.ok(estimateContextTokens(harness.session.messages).tokens > 31_000);
	});

	it("keeps the compacted text when the whole replacement fits below the trigger", async () => {
		vi.stubGlobal("fetch", endpoint(() => json({ output: "word ".repeat(12_400) })).fetch);
		harness = await budgetHarness("rules");
		const result = await harness.session.compact();
		assert.equal(result.form, "compacted");
		assert.ok(estimateContextTokens(harness.session.messages).tokens < 31_000);
	});

	/** An endpoint that answers only when its request is aborted, and says when a request arrived. */
	function hangingEndpoint(): { fetch: typeof fetch; arrived: Promise<void> } {
		const arrived = Promise.withResolvers<void>();
		const fake = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				arrived.resolve();
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			})) as typeof fetch;
		return { fetch: fake, arrived: arrived.promise };
	}

	it("stopping a manual compactor request clears the context instead of cancelling", async () => {
		const hanging = hangingEndpoint();
		vi.stubGlobal("fetch", hanging.fetch);
		harness = await compactorHarness(true);
		const compacting = harness.session.compact();
		await hanging.arrived;
		harness.session.abortCompaction();
		const result = await compacting;
		assert.equal(result.form, "cleared");
		assert.match(result.fallbackReason ?? "", /aborted/u);
		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.equal(convertToLlm(harness.session.messages).filter((message) => message.role !== "system").length, 1);
	});

	it("stopping an automatic compactor request clears the context instead of cancelling", async () => {
		const hanging = hangingEndpoint();
		vi.stubGlobal("fetch", hanging.fetch);
		harness = await compactorHarness(true);
		const internals = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<string>;
		};
		const running = internals._runAutoCompaction("threshold", false);
		await hanging.arrived;
		harness.session.abortCompaction();
		assert.equal(await running, "compacted");
		const [end] = harness.eventsOfType("compaction_end");
		assert.equal(end?.result?.form, "cleared");
		assert.match(end?.result?.fallbackReason ?? "", /aborted/u);
	});

	it("a manual takeover of an automatic compactor request writes only the manual boundary", async () => {
		const hanging = hangingEndpoint();
		vi.stubGlobal("fetch", hanging.fetch);
		harness = await compactorHarness(true);
		const internals = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<string>;
		};
		const automatic = internals._runAutoCompaction("threshold", false);
		await hanging.arrived;
		vi.stubGlobal("fetch", endpoint(() => json({ output: "manual compacted text" })).fetch);
		const manual = await harness.session.compact();
		await automatic;
		assert.equal(manual.form, "compacted");
		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		const ends = harness.eventsOfType("compaction_end");
		assert.deepEqual(
			ends.map((event) => [event.reason, event.aborted]),
			[
				["threshold", true],
				["manual", false],
			],
		);
	});

	it("a chat model named for one run clears the context and says why", async () => {
		harness = await compactorHarness(false);
		const chat = `${harness.getModel().provider}/${harness.getModel().id}`;
		const result = await harness.session.compact({ compactionModel: chat });
		assert.equal(result.form, "cleared");
		assert.equal(result.fallbackReason, `${chat} is a chat model, not a compactor`);
	});

	it("the extension hook can still cancel or supply the replacement context", async () => {
		const replaced = await createHarness({
			extensionFactories: [
				(atomic) => {
					atomic.on("session_before_compact", (event) =>
						event.reason === "manual" && event.preparation.parameters.query.includes("cancel")
							? { cancel: true }
							: { compactedText: "extension summary" },
					);
				},
			],
		});
		harness = replaced;
		replaced.setResponses([fauxAssistantMessage("answer")]);
		await replaced.session.prompt("task");
		await assert.rejects(replaced.session.compact({ query: "please cancel" }), /cancelled/u);
		assert.equal(replaced.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
		const result = await replaced.session.compact();
		assert.equal(result.form, "compacted");
		assert.equal(result.backend, "extension");
		assert.ok(result.compactedText.includes("<compacted-context>\nextension summary\n</compacted-context>"));
		assert.ok(result.compactedText.includes(`history://sessions/${replaced.session.sessionId}`));
	});
});
