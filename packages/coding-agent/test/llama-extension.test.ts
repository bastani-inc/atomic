import { once } from "node:events";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AuthContext,
	AuthPrompt,
	ModelsPublication,
	ModelsRefreshOptions,
	ModelsStoreEntry,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { LlamaClient, type LlamaProgress, normalizeLlamaServerUrl } from "../src/extensions/llama/client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "../src/extensions/llama/huggingface.ts";
import llamaExtension from "../src/extensions/llama/index.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";
import type { LlamaUi } from "../src/extensions/llama/ui.ts";

const llamaUiProbe = vi.hoisted(() => ({ connectionErrors: [] as string[] }));

vi.mock("../src/extensions/llama/ui.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/llama/ui.ts")>();
	return {
		...actual,
		showLlamaUi: async (_ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> => {
			await run({
				showModels: async () => ({ type: "close" }),
				select: async () => undefined,
				confirm: async () => false,
				connectionError: async (_serverUrl, message) => {
					llamaUiProbe.connectionErrors.push(message);
					return "close";
				},
				searchModels: async () => undefined,
				showStatus: () => {},
				progress: async () => {},
				updateProgress: () => {},
			});
		},
	};
});
const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	llamaUiProbe.connectionErrors.length = 0;
});

describe("llama.cpp extension", () => {
	it("registers a native provider and /llama command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:llama.cpp>",
		);

		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		// Atomic's loader tracks native and legacy registrations in one pending list.
		expect(
			runtime.pendingProviderRegistrations.map((entry) => ("provider" in entry ? entry.provider.id : entry.name)),
		).toEqual([LLAMA_PROVIDER_ID]);
	});

	it.each([
		{
			name: "aborted refreshes",
			result: { aborted: true, errors: new Map<string, Error>() },
			expected: "Model catalog refresh timed out.",
		},
		{
			name: "provider refresh errors",
			result: { aborted: false, errors: new Map([[LLAMA_PROVIDER_ID, new Error("refresh failed")]]) },
			expected: "refresh failed",
		},
	])("reports $name and scopes the production refresh", async ({ result, expected }) => {
		const { url } = await listen((_request, response) => json(response, { data: [] }));
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"<inline:llama.cpp>",
		);
		const refresh = vi.fn(async (_options: ModelsRefreshOptions) => result);
		const context = {
			mode: "tui",
			ui: { notify: vi.fn() },
			modelRegistry: {
				getProviderAuth: async () => ({
					auth: { apiKey: "local", baseUrl: `${url}/v1` },
					env: { LLAMA_BASE_URL: url },
				}),
				refresh,
			},
		} as unknown as ExtensionCommandContext;

		await extension.commands.get("llama")?.handler("", context);

		expect(llamaUiProbe.connectionErrors).toEqual([expected]);
		expect(refresh).toHaveBeenCalledOnce();
		const refreshOptions = refresh.mock.calls[0]?.[0];
		expect(refreshOptions?.providers).toEqual([LLAMA_PROVIDER_ID]);
		expect(refreshOptions?.signal).toBeInstanceOf(AbortSignal);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes only loaded models with router metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "loaded",
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					architecture: { input_modalities: ["text", "image"] },
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
				{ id: "unloaded", status: { value: "unloaded" } },
				{ id: "loading", status: { value: "loading" } },
			],
			"http://localhost:8080",
		);

		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "loaded",
				baseUrl: "http://localhost:8080/v1",
				contextWindow: 65536,
				maxTokens: 65536,
				input: ["text", "image"],
			}),
		]);
	});

	it("persists and restores loaded models for cache-only startup refreshes", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		const refreshContext = (allowNetwork: boolean): RefreshModelsContext => ({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			allowNetwork,
			signal: new AbortController().signal,
			publish: async ({ persist, update }: ModelsPublication): Promise<boolean> => {
				if (persist !== undefined) cachedEntry = persist === null ? undefined : structuredClone(persist);
				update?.();
				return true;
			},
		});
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const first = createLlamaProvider();
		await first.provider.refreshModels?.(refreshContext(true));
		expect(first.provider.getModels().map((model) => model.id)).toEqual(["loaded"]);
		expect(cachedEntry?.models.map((model) => model.id)).toEqual(["loaded"]);

		const second = createLlamaProvider();
		await second.provider.refreshModels?.(refreshContext(false));
		expect(second.provider.getModels()).toEqual([
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
	});

	it("stays dormant until configured and stores URL plus optional key", async () => {
		const { provider } = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		expect(await auth.check?.({ ctx: emptyContext })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext })).toBeUndefined();

		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer secret");
			json(response, { data: [] });
		});
		const answers = [url, "secret"];
		const credential = await auth.login!({
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			notify: () => {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: url },
		});
		expect(await auth.resolve({ ctx: emptyContext, credential })).toEqual({
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			env: { LLAMA_BASE_URL: url },
			source: "stored credential",
		});
	});

	it("searches Hugging Face and reads quantizations plus access requirements", async () => {
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer hf-secret");
			if (request.url?.startsWith("/api/models?")) {
				const requestUrl = new URL(request.url, "http://localhost");
				expect(requestUrl.searchParams.get("search")).toBe("qwen coder");
				expect(requestUrl.searchParams.get("filter")).toBe("gguf");
				expect(requestUrl.searchParams.get("sort")).toBe("downloads");
				json(response, [{ id: "owner/model-GGUF", downloads: 1200 }]);
				return;
			}
			if (request.url === "/api/models/owner/model-GGUF?blobs=true") {
				json(response, {
					id: "owner/model-GGUF",
					gated: "manual",
					siblings: [
						{ rfilename: "model-Q5_K_M.gguf", size: 6000 },
						{ rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2000 },
						{ rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3000 },
						{ rfilename: "mmproj-F16.gguf", size: 1000 },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});
		const client = new HuggingFaceClient("hf-secret", url);

		expect(await client.search("qwen coder")).toEqual([{ id: "owner/model-GGUF", downloads: 1200 }]);
		expect(await client.details("owner/model-GGUF")).toEqual({
			id: "owner/model-GGUF",
			gated: "manual",
			quantizations: [
				{ name: "Q4_K_M", size: 5000 },
				{ name: "Q5_K_M", size: 6000 },
			],
		});
		expect(await findHuggingFaceToken({ HF_TOKEN: " hf-secret " })).toBe("hf-secret");
	});

	it("loads with SSE progress and waits for the loaded catalog state", async () => {
		let status: "unloaded" | "loading" | "loaded" = "unloaded";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models/load" && request.method === "POST") {
				status = "loading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "test-model",
						event: "status_change",
						data: {
							status: "loading",
							progress: { stages: ["text_model", "mmproj_model"], current: "text_model", value: 0.5 },
						},
					});
					status = "loaded";
					send({ model: "test-model", event: "status_change", data: { status: "loaded" } });
				}, 20);
				return;
			}
			if (request.url === "/models") {
				json(response, { data: [{ id: "test-model", status: { value: status } }] });
				return;
			}
			response.writeHead(404).end();
		});

		const progress: string[] = [];
		const model = await new LlamaClient(url).loadAndWait("test-model", (entry) => progress.push(entry.message));
		expect(model.status.value).toBe("loaded");
		expect(progress).toContain("Loading text model");
	});

	it("downloads with byte progress and returns the refreshed catalog", async () => {
		let status: "missing" | "downloading" | "unloaded" = "missing";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models" && request.method === "POST") {
				status = "downloading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "owner/repo:Q4_K_M",
						event: "download_progress",
						data: { progress: { "https://example/model.gguf": { done: 512, total: 1024 } } },
					});
					status = "unloaded";
					send({ model: "owner/repo:Q4_K_M", event: "download_finished", data: {} });
				}, 20);
				return;
			}
			if (request.url?.startsWith("/models")) {
				json(response, {
					data: status === "missing" ? [] : [{ id: "owner/repo:Q4_K_M", status: { value: status } }],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const progress: LlamaProgress[] = [];
		const models = await new LlamaClient(url).downloadAndWait("owner/repo:Q4_K_M", (entry) => progress.push(entry));
		expect(models).toEqual([{ id: "owner/repo:Q4_K_M", status: { value: "unloaded" } }]);
		expect(progress).toContainEqual({
			message: "Downloading model",
			ratio: 0.5,
			detail: "512 B / 1.00 KiB",
		});
	});
});
