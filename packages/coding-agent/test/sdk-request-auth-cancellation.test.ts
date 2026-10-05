import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAskUserQuestionToolDefinition } from "../src/core/tools/ask-user-question/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Issue #3085

const REQUEST_AUTH_PREPARATION_TIMEOUT_MS = 15_000;
const FIRST_AUTH_DELAY_MS = 14_000;
const DEFAULT_AGENT_RETRY_BACKOFF_MS = 14_000;

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function message(model: { api: string; provider: string; id: string }, extra: Record<string, unknown> = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
		...extra,
	};
}

function response(model: { api: string; provider: string; id: string }, extra: Record<string, unknown> = {}) {
	const stream = new AssistantMessageEventStream();
	const msg = message(model, extra);
	stream.push({ type: "start", partial: msg });
	stream.push(
		msg.stopReason === "error"
			? { type: "error", reason: "error", error: msg }
			: { type: "done", reason: msg.stopReason, message: msg },
	);
	stream.end(msg);
	return stream;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createAgentSession request-auth cancellation", () => {
	const cleanup: Array<() => void | Promise<void>> = [];

	// #3105: finish session persistence before deleting the fixture directory.
	afterEach(async () => {
		vi.useRealTimers();
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
	});

	async function fixture({
		refresh,
		stream,
		primaryStream,
		fallback = false,
		tools = [],
		bindUi,
	}: {
		refresh?: (
			credential: { access: string; refresh: string; expires: number },
			signal: AbortSignal,
		) => Promise<unknown>;
		stream?: (
			model: { api: string; provider: string; id: string },
			context: unknown,
			options: { signal?: AbortSignal },
		) => AssistantMessageEventStream;
		primaryStream?: (
			model: { api: string; provider: string; id: string },
			context: unknown,
			options: { signal?: AbortSignal },
		) => AssistantMessageEventStream;
		fallback?: boolean;
		tools?: NonNullable<Parameters<typeof createAgentSession>[0]["customTools"]>;
		bindUi?: Parameters<Awaited<ReturnType<typeof createAgentSession>>["session"]["bindExtensions"]>[0];
	} = {}) {
		const dir = mkdtempSync(join(tmpdir(), "atomic-3085-sdk-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const credentials = AuthStorage.inMemory({
			probe: { type: "oauth", access: "fabricated", refresh: "fabricated", expires: 1 },
			primary: { type: "api_key", key: "fabricated" },
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		let calls = 0;
		let refreshes = 0;
		runtime.registerProvider("probe", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			oauth: {
				name: "probe",
				login: async () => {
					throw new Error("not used");
				},
				refreshToken: async (credential, signal) => {
					refreshes++;
					return refresh ? refresh(credential, signal) : { ...credential, expires: Number.MAX_SAFE_INTEGER };
				},
				getApiKey: (credential) => credential.access,
			},
			models: [spec],
			streamSimple: (model, context, options) => {
				calls++;
				return stream ? stream(model, context, options) : response(model);
			},
		});
		runtime.registerProvider("primary", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "fabricated",
			models: [spec],
			streamSimple: (model, context, options) =>
				primaryStream
					? primaryStream(model, context, options)
					: response(model, { content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		});
		const settings = SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
			compaction: { enabled: false },
		});
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			model: runtime.getModel(fallback ? "primary" : "probe", "m")!,
			fallbackModels: fallback ? ["probe/m"] : [],
			settingsManager: settings,
			sessionManager: manager,
			resourceLoader: createTestResourceLoader(),
			tools: tools.map((tool) => tool.name),
			customTools: tools,
		});
		if (bindUi) await session.bindExtensions(bindUi);
		cleanup.push(() => session.dispose());
		return { session, runtime, credentials, manager, calls: () => calls, refreshes: () => refreshes };
	}

	function diskErrors(manager: SessionManager) {
		const path = manager.getSessionFile();
		expect(path && existsSync(path)).toBe(true);
		return readFileSync(path!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
	}

	// #3429: a started provider rotation must survive caller cancellation (#3085).
	it("stops waiting after session.abort but persists an already-started OAuth rotation", async () => {
		const entered = deferred();
		const late = deferred<unknown>();
		let signal: AbortSignal | undefined;
		const f = await fixture({
			refresh: async (_credential, refreshSignal) => {
				signal = refreshSignal;
				entered.resolve();
				return late.promise;
			},
		});
		vi.useFakeTimers();
		const prompt = f.session.prompt("go");
		await vi.advanceTimersByTimeAsync(0);
		await entered.promise;
		let stopped = false;
		let promptStopped = false;
		void prompt.then(() => {
			promptStopped = true;
		});
		const abort = f.session.abort().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		try {
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);
			expect(stopped).toBe(true);
			expect(promptStopped).toBe(true);
		} finally {
			late.resolve({
				type: "oauth",
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: Number.MAX_SAFE_INTEGER,
			});
			await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
			await abort;
			await prompt;
		}
		expect(f.calls()).toBe(0);
		expect(f.refreshes()).toBe(1);
		expect(await f.credentials.read("probe")).toEqual({
			type: "oauth",
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect(await f.credentials.read("primary")).toEqual({ type: "api_key", key: "fabricated" });
	});

	it("does not start a queued OAuth refresh or overwrite replacement credentials after session.abort", async () => {
		const f = await fixture();
		const entered = deferred();
		const release = deferred();
		const replacement = { type: "api_key" as const, key: "replacement" };
		const mutation = f.credentials.modify("probe", async () => {
			entered.resolve();
			await release.promise;
			return replacement;
		});
		await entered.promise;
		vi.useFakeTimers();
		const prompt = f.session.prompt("go");
		await vi.advanceTimersByTimeAsync(0);
		const abort = f.session.abort();
		await vi.advanceTimersByTimeAsync(100);
		try {
			await abort;
			await prompt;
			expect(f.refreshes()).toBe(0);
		} finally {
			release.resolve();
			await mutation;
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(await f.credentials.read("probe")).toEqual(replacement);
		expect(await f.credentials.read("primary")).toEqual({ type: "api_key", key: "fabricated" });
		expect(f.refreshes()).toBe(0);
		expect(f.calls()).toBe(0);
	});

	it("persists primary rate-limit errors while fallback auth is gated and settles at 29s", async () => {
		let enteredAt: number | undefined;
		const f = await fixture({
			fallback: true,
			refresh: async () => {
				enteredAt = Date.now();
				return new Promise(() => {});
			},
		});
		vi.useFakeTimers();
		const start = Date.now();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(diskErrors(f.manager)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(diskErrors(f.manager)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(4000);
		expect(diskErrors(f.manager)).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(8000);
		expect(enteredAt).toBeDefined();
		expect(enteredAt! - start).toBeLessThanOrEqual(DEFAULT_AGENT_RETRY_BACKOFF_MS + 10);
		const errors = diskErrors(f.manager);
		expect(errors).toHaveLength(4);
		expect(errors.every((entry) => /429/.test(entry.message.errorMessage))).toBe(true);
		await vi.advanceTimersByTimeAsync(enteredAt! + REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1 - Date.now());
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		await pending;
		const all = diskErrors(f.manager);
		expect(all).toHaveLength(5);
		expect(all.at(-1)?.message.errorMessage).toMatch(/authentication timed out/i);
		expect(all.at(-1)?.message.errorMessage).not.toMatch(/log in/i);
		expect(f.calls()).toBe(0);
	});

	it("persists an immediate expired-OAuth fallback error once after primary exhaustion", async () => {
		const f = await fixture({
			fallback: true,
			refresh: async () => {
				throw new Error("refresh token expired; please log in");
			},
		});
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_RETRY_BACKOFF_MS + 10);
		expect(done).toBe(true);
		await pending;
		const errors = diskErrors(f.manager);
		expect(errors).toHaveLength(5);
		expect(errors.at(-1)?.message.errorMessage).toMatch(/refresh token expired/i);
	});

	it("keeps an ask_user_question wait past the auth bound and applies a fresh bound after the answer", async () => {
		const entered = deferred();
		const answer = deferred();
		const releaseAuth = deferred();
		let postAnswerAuth = false;
		let turns = 0;
		let f: Awaited<ReturnType<typeof fixture>>;
		const tool = createAskUserQuestionToolDefinition();
		f = await fixture({
			tools: [tool],
			refresh: async (credential) => {
				if (postAnswerAuth) await releaseAuth.promise;
				return { ...credential, expires: Number.MAX_SAFE_INTEGER };
			},
			stream: (model: { api: string; provider: string; id: string }) => {
				turns++;
				return response(model, {
					content: [
						{
							type: "toolCall",
							id: "q",
							name: "ask_user_question",
							arguments: {
								questions: [
									{
										question: "Continue?",
										header: "Continue",
										options: [
											{ label: "Yes", description: "Continue now." },
											{ label: "No", description: "Stop here." },
										],
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				});
			},
			bindUi: {
				mode: "tui",
				uiContext: {
					...noOpUIContext,
					custom: async () => {
						entered.resolve();
						await answer.promise;
						postAnswerAuth = true;
						await f.credentials.modify("probe", async () => ({
							type: "oauth",
							access: "expired",
							refresh: "fabricated",
							expires: 1,
						}));
						return {
							answers: [{ questionIndex: 0, question: "Continue?", kind: "option", answer: "Yes" }],
							cancelled: false,
						};
					},
				},
			},
		});
		// #3105: settle the timed-out provider callback before disposal drains owned work.
		cleanup.push(() => releaseAuth.resolve());
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("ask").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		await entered.promise;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(done).toBe(false);
		expect(turns).toBe(1);
		answer.resolve();
		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		await pending;
		expect(turns).toBe(1);
		expect(f.calls()).toBe(1);
		expect(diskErrors(f.manager).at(-1)?.message.errorMessage).toMatch(/authentication timed out/i);
		expect(diskErrors(f.manager).at(-1)?.message.errorMessage).not.toMatch(/log in/i);
	});

	it.each(["quiet", "streaming"] as const)("keeps a healthy %s stream open past the auth bound", async (mode) => {
		const entered = deferred();
		let out: AssistantMessageEventStream | undefined;
		let model: { api: string; provider: string; id: string } | undefined;
		const f = await fixture({
			stream: (requestModel: { api: string; provider: string; id: string }) => {
				model = requestModel;
				out = new AssistantMessageEventStream();
				out.push({ type: "start", partial: message(requestModel) });
				entered.resolve();
				return out;
			},
		});
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		await entered.promise;
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS);
			if (mode === "streaming") {
				out!.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: message(model!) });
			}
			expect(done).toBe(false);
		}
		const msg = message(model!);
		out!.push({ type: "done", reason: "stop", message: msg });
		out!.end(msg);
		await vi.advanceTimersByTimeAsync(0);
		await pending;
		expect(done).toBe(true);
		expect(f.calls()).toBe(1);
	});

	it("cancels a never-ending request without a later fallback dispatch", async () => {
		let started = false;
		let captured: AbortSignal | undefined;
		const f = await fixture({
			fallback: true,
			primaryStream: (
				model: { api: string; provider: string; id: string },
				_context: unknown,
				options: { signal?: AbortSignal },
			) => {
				started = true;
				captured = options.signal;
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "start", partial: message(model) });
				options.signal?.addEventListener(
					"abort",
					() => {
						const msg = message(model, { stopReason: "aborted", errorMessage: "aborted", content: [] });
						stream.push({ type: "error", reason: "aborted", error: msg });
						stream.end(msg);
					},
					{ once: true },
				);
				return stream;
			},
		});
		vi.useFakeTimers();
		const pending = f.session.prompt("go");
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		let stopped = false;
		const abort = f.session.abort().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(captured?.aborted).toBe(true);
		expect(stopped).toBe(true);
		await abort;
		await pending;
		expect(f.refreshes()).toBe(0);
		expect(f.calls()).toBe(0);
		expect(f.session.messages.at(-1)?.stopReason).toBe("aborted");
	});

	it("cancels during primary backoff without dispatching configured fallback", async () => {
		const f = await fixture({
			fallback: true,
			refresh: async (credential) => ({ ...credential, expires: Number.MAX_SAFE_INTEGER }),
		});
		vi.useFakeTimers();
		const pending = f.session.prompt("go");
		await vi.advanceTimersByTimeAsync(1);
		expect(diskErrors(f.manager)).toHaveLength(1);
		const abort = f.session.abort();
		await vi.advanceTimersByTimeAsync(1);
		await abort;
		await pending;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.refreshes()).toBe(0);
		expect(f.calls()).toBe(0);
	});

	it("keeps a long tool pending past the auth bound then completes", async () => {
		const entered = deferred();
		const release = deferred();
		let turns = 0;
		const f = await fixture({
			tools: [
				{
					name: "slow",
					label: "slow",
					description: "local gated tool",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						entered.resolve();
						await release.promise;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
			stream: (model) =>
				++turns === 1
					? response(model, {
							stopReason: "toolUse",
							content: [{ type: "toolCall", id: "slow-1", name: "slow", arguments: {} }],
						})
					: response(model),
		});
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		await entered.promise;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(done).toBe(false);
		expect(turns).toBe(1);
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await pending;
		expect(turns).toBe(2);
		expect(f.session.getLastAssistantText()).toBe("ok");
	});

	it("keeps a successful fallback answer and the primary rate-limit errors", async () => {
		const f = await fixture({ fallback: true });
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_RETRY_BACKOFF_MS + 10);
		expect(done).toBe(true);
		await pending;
		expect(f.calls()).toBe(1);
		expect(f.session.getLastAssistantText()).toBe("ok");
		expect(diskErrors(f.manager)).toHaveLength(4);
	});

	it("reuses SDK request auth so a slow first resolution cannot start a second 15s deadline (#3087)", async () => {
		// Delay the real OAuth toAuth inside the resolver deadline. Wrapping getRequestAuth
		// outside that bound would not prove a second derivation cannot acquire another 15s.
		const f = await fixture({
			refresh: async (credential) => ({ ...credential, expires: Number.MAX_SAFE_INTEGER }),
		});
		const oauth = f.runtime.getProvider("probe")?.auth.oauth;
		expect(oauth).toBeDefined();
		const originalToAuth = oauth!.toAuth.bind(oauth);
		let derivations = 0;
		let allow = 1;
		oauth!.toAuth = async (credential) => {
			derivations++;
			if (derivations > allow) return new Promise(() => {});
			if (derivations === 1) {
				await new Promise((resolve) => setTimeout(resolve, FIRST_AUTH_DELAY_MS));
			}
			return originalToAuth(credential);
		};

		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(FIRST_AUTH_DELAY_MS - 1);
		expect(done).toBe(false);
		expect(f.calls()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		await pending;
		expect(derivations).toBe(1);
		expect(f.calls()).toBe(1);

		allow = 2;
		const second = f.session.prompt("again");
		await vi.advanceTimersByTimeAsync(0);
		await second;
		expect(derivations).toBe(2);
		expect(f.calls()).toBe(2);
	});

	it("fails a never-settling first auth at 15s with no dispatch (#3085)", async () => {
		const f = await fixture({
			refresh: async () => new Promise(() => {}),
		});
		vi.useFakeTimers();
		let done = false;
		const pending = f.session.prompt("go").finally(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		expect(done).toBe(false);
		expect(f.calls()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		await pending;
		expect(f.calls()).toBe(0);
		expect(diskErrors(f.manager).at(-1)?.message.errorMessage).toMatch(/authentication timed out/i);
		expect(diskErrors(f.manager).at(-1)?.message.errorMessage).not.toMatch(/log in/i);
	});
});
