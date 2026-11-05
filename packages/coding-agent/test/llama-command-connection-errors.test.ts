import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.js";
import llamaExtension from "../src/extensions/llama/index.js";
import type { LlamaManagerAction, LlamaUi } from "../src/extensions/llama/ui.js";

const scriptedUi = vi.hoisted(() => ({ current: undefined as LlamaUi | undefined }));

vi.mock("../src/extensions/llama/ui.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/extensions/llama/ui.js")>()),
	showLlamaUi: async (_ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>) => {
		if (!scriptedUi.current) throw new Error("no scripted llama UI");
		await run(scriptedUi.current);
	},
}));

const SERVER_URL = "http://127.0.0.1:8080";
const LOADED_MODEL = { id: "loaded-model", status: { value: "loaded" } };

type Notification = { message: string; level: string | undefined };

function networkFailure(): TypeError {
	return new TypeError("fetch failed", {
		cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }),
	});
}

function modelsResponse(): Response {
	return new Response(JSON.stringify({ data: [LOADED_MODEL] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function stubServer(handle: (path: string) => Response | Error): void {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const outcome = handle(url.pathname);
		if (outcome instanceof Error) throw outcome;
		return outcome;
	});
}

function scriptUi(actions: LlamaManagerAction[], connectionMessages: string[]): void {
	const remaining = [...actions];
	scriptedUi.current = {
		showModels: async () => remaining.shift() ?? { type: "close" },
		select: async () => undefined,
		confirm: async () => true,
		connectionError: async (_serverUrl, message) => {
			connectionMessages.push(message);
			return "close";
		},
		searchModels: async () => undefined,
		showStatus: () => {},
		progress: async () => {},
		updateProgress: () => {},
	};
}

async function runLlamaCommand(): Promise<Notification[]> {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const pi = {
		registerProvider: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			if (name === "llama") command = options;
		},
	} as Partial<ExtensionAPI> as ExtensionAPI;
	llamaExtension(pi);
	assert.ok(command);

	const notifications: Notification[] = [];
	const ctx = {
		mode: "tui",
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { baseUrl: SERVER_URL }, env: {} }),
			refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
		},
	} as Partial<ExtensionCommandContext> as ExtensionCommandContext;
	await command.handler("", ctx);
	return notifications;
}

afterEach(() => {
	vi.unstubAllGlobals();
	scriptedUi.current = undefined;
});

describe("/llama connection failures", () => {
	it("returns to the catalog without an error notification when a model action cannot reach the server", async () => {
		stubServer((path) => (path === "/models/unload" ? networkFailure() : modelsResponse()));
		scriptUi([{ type: "model", model: LOADED_MODEL }], []);

		const notifications = await runLlamaCommand();

		assert.deepEqual(
			notifications.filter((notification) => notification.level === "error"),
			[],
		);
	});

	it("reports a model action that fails for another reason", async () => {
		stubServer((path) =>
			path === "/models/unload"
				? new Response(JSON.stringify({ error: { message: "model is busy" } }), { status: 409 })
				: modelsResponse(),
		);
		scriptUi([{ type: "model", model: LOADED_MODEL }], []);

		const notifications = await runLlamaCommand();

		assert.deepEqual(notifications, [{ message: "model is busy", level: "error" }]);
	});

	it("names the unreachable server and its cause when the catalog cannot be read", async () => {
		stubServer(() => networkFailure());
		const connectionMessages: string[] = [];
		scriptUi([], connectionMessages);

		await runLlamaCommand();

		assert.equal(connectionMessages.length, 1);
		assert.ok(
			connectionMessages[0]?.startsWith(
				`Could not reach llama.cpp server at ${SERVER_URL}: connect ECONNREFUSED 127.0.0.1:8080 (server-unreachable).`,
			),
			connectionMessages[0],
		);
	});

	it("shows a short connection message when the server does not answer in time", async () => {
		stubServer(() => new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const connectionMessages: string[] = [];
		scriptUi([], connectionMessages);

		await runLlamaCommand();

		assert.deepEqual(connectionMessages, ["Could not connect to the server."]);
	});
});
