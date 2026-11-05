import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, vi } from "vitest";
import { LlamaClient } from "../src/extensions/llama/client.ts";
import {
	findLlamaServerError,
	isLlamaServerError,
	isLlamaServerUnreachableError,
	LlamaServerError,
	LlamaServerUnreachableError,
	rehydrateLlamaServerError,
} from "../src/extensions/llama/errors.ts";

async function closedPort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("llama.cpp server errors (pi #11779)", () => {
	it("names the server and the cause when it cannot be reached", async () => {
		const port = await closedPort();
		const error = await new LlamaClient(`http://127.0.0.1:${port}`).list().then(
			() => undefined,
			(failure: unknown) => failure,
		);

		assert.ok(error instanceof LlamaServerUnreachableError);
		assert.ok(isLlamaServerUnreachableError(error));
		assert.ok(isLlamaServerError(error));
		assert.equal(error.name, "LlamaServerUnreachableError");
		assert.equal(error.code, "server-unreachable");
		assert.equal(error.serverUrl, `http://127.0.0.1:${port}`);
		assert.equal(error.detail, `connect ECONNREFUSED 127.0.0.1:${port}`);
		assert.equal(error.retryable, true);
		assert.ok(error.hint?.includes("llama-server is running"));
		assert.ok(error.cause instanceof Error);
		// The one rendered-message contract check.
		assert.equal(
			error.message,
			`Could not reach llama.cpp server at http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port} (server-unreachable). ${error.hint}`,
		);
	});

	it("names the server for the model event stream too", async () => {
		const port = await closedPort();
		const error = await new LlamaClient(`http://127.0.0.1:${port}`)
			.watch(() => {})
			.then(
				() => undefined,
				(failure: unknown) => failure,
			);
		assert.ok(isLlamaServerUnreachableError(error));
		assert.equal(error.code, "server-unreachable");
	});

	it("rethrows a cancellation unchanged instead of reporting the server unreachable", async () => {
		const port = await closedPort();
		const controller = new AbortController();
		const reason = new Error("cancelled by the user");
		controller.abort(reason);
		const error = await new LlamaClient(`http://127.0.0.1:${port}`).list({ signal: controller.signal }).then(
			() => undefined,
			(failure: unknown) => failure,
		);
		assert.equal(isLlamaServerError(error), false);
	});

	it("keeps credentials in the server URL out of the message and fields", () => {
		const error = new LlamaServerUnreachableError("http://user:secret@127.0.0.1:8080", "connect ECONNREFUSED");
		assert.equal(error.serverUrl, "http://127.0.0.1:8080");
		assert.equal(error.message.includes("secret"), false);
		assert.equal(JSON.stringify(error.toJSON()).includes("secret"), false);
	});

	it("round-trips across a process boundary with its class, fields and cause", () => {
		const socket = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
		const original = new LlamaServerUnreachableError("http://127.0.0.1:8080", socket.message, {
			cause: new TypeError("fetch failed", { cause: socket }),
		});

		const relayed = JSON.parse(JSON.stringify(original));
		const rehydrated = rehydrateLlamaServerError(relayed);

		assert.ok(rehydrated instanceof LlamaServerUnreachableError);
		assert.ok(isLlamaServerUnreachableError(rehydrated));
		assert.equal(rehydrated.code, "server-unreachable");
		assert.equal(rehydrated.serverUrl, "http://127.0.0.1:8080");
		assert.equal((rehydrated as LlamaServerUnreachableError).detail, socket.message);
		assert.equal(rehydrated.message, original.message);
		assert.equal(rehydrated.retryable, true);
		assert.ok(rehydrated.cause instanceof Error);
		assert.equal((rehydrated.cause as Error).message, "fetch failed");
		assert.equal(((rehydrated.cause as Error).cause as Error & { code?: string }).code, "ECONNREFUSED");
	});

	it("rehydrates an unknown family member into the base with its name and code", () => {
		const rehydrated = rehydrateLlamaServerError({
			name: "LlamaServerFutureError",
			code: "server-unreachable",
			message: "future failure",
			retryable: false,
			fields: { serverUrl: "http://127.0.0.1:8080" },
		});
		assert.ok(rehydrated instanceof LlamaServerError);
		assert.equal(rehydrated.name, "LlamaServerFutureError");
		assert.equal(rehydrated.code, "server-unreachable");
		assert.equal(rehydrated.retryable, false);
	});

	it("matches structurally across realms and through a wrapping cause", () => {
		const foreign = { name: "LlamaServerUnreachableError", code: "server-unreachable", message: "x" };
		assert.ok(isLlamaServerError(foreign));
		assert.ok(isLlamaServerUnreachableError(foreign));
		assert.equal(isLlamaServerError({ name: "LlamaServerUnreachableError", code: "other" }), false);
		assert.equal(isLlamaServerError(new Error("Could not reach llama.cpp server")), false);

		const wrapped = new Error("Failed to save API key for llama.cpp", {
			cause: new LlamaServerUnreachableError("http://127.0.0.1:8080", "connect ECONNREFUSED"),
		});
		assert.equal(findLlamaServerError(wrapped)?.code, "server-unreachable");
		assert.equal(findLlamaServerError(new Error("unrelated")), undefined);
	});

	it("serializes the base error with only the facts it has", () => {
		const bare = new LlamaServerError("boom", {
			code: "server-unreachable",
			serverUrl: "http://user:secret@127.0.0.1:8080",
			retryable: false,
		});
		assert.equal(bare.name, "LlamaServerError");
		assert.equal(Object.hasOwn(bare, "cause"), false);
		assert.deepEqual(bare.fields, { serverUrl: "http://127.0.0.1:8080" });
		assert.deepEqual(bare.toJSON(), {
			name: "LlamaServerError",
			code: "server-unreachable",
			message: "boom",
			retryable: false,
			fields: { serverUrl: "http://127.0.0.1:8080" },
		});

		const full = new LlamaServerError("boom", {
			code: "server-unreachable",
			serverUrl: "http://127.0.0.1:8080",
			hint: "try again",
			retryable: true,
			cause: new Error("root"),
		});
		assert.deepEqual(full.toJSON(), {
			name: "LlamaServerError",
			code: "server-unreachable",
			message: "boom",
			hint: "try again",
			retryable: true,
			fields: { serverUrl: "http://127.0.0.1:8080" },
			cause: { name: "Error", message: "root" },
		});
	});

	it("serializes the unreachable error with its detail field and hint", () => {
		const error = new LlamaServerUnreachableError("http://127.0.0.1:8080", "connect ECONNREFUSED");
		assert.deepEqual(error.toJSON(), {
			name: "LlamaServerUnreachableError",
			code: "server-unreachable",
			message: error.message,
			hint: error.hint,
			retryable: true,
			fields: { serverUrl: "http://127.0.0.1:8080", detail: "connect ECONNREFUSED" },
		});
	});

	it("keeps a server URL that cannot be parsed as given", () => {
		const error = new LlamaServerUnreachableError("not a url", "connect ECONNREFUSED");
		assert.equal(error.serverUrl, "not a url");
	});

	it("tells the family base apart from the unreachable error", () => {
		const base = new LlamaServerError("boom", {
			code: "server-unreachable",
			serverUrl: "http://x",
			retryable: false,
		});
		assert.ok(isLlamaServerError(base));
		assert.equal(isLlamaServerUnreachableError(base), false);
		assert.equal(isLlamaServerUnreachableError(new Error("boom")), false);
		assert.equal(isLlamaServerUnreachableError(undefined), false);
		assert.ok(isLlamaServerError({ name: "LlamaServerError", code: "server-unreachable" }));
		assert.equal(isLlamaServerUnreachableError({ name: "LlamaServerError", code: "server-unreachable" }), false);
		assert.equal(isLlamaServerUnreachableError({ name: "LlamaServerUnreachableError", code: "other" }), false);
	});

	it("rehydrates missing fields as empty strings", () => {
		const unreachable = rehydrateLlamaServerError({
			name: "LlamaServerUnreachableError",
			code: "server-unreachable",
			message: "x",
			retryable: true,
			fields: {},
		});
		assert.ok(unreachable instanceof LlamaServerUnreachableError);
		assert.equal(unreachable.serverUrl, "");
		assert.equal(unreachable.detail, "");

		const base = rehydrateLlamaServerError({
			name: "LlamaServerFutureError",
			code: "server-unreachable",
			message: "future",
			hint: "later",
			retryable: false,
			fields: { serverUrl: 3 },
		});
		assert.equal(base.serverUrl, "");
		assert.equal(base.hint, "later");
	});
});

describe("llama.cpp connection failure detail", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function detailOf(failure: Error): Promise<string | undefined> {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
		const error = await new LlamaClient("http://127.0.0.1:8080").list().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		assert.ok(isLlamaServerUnreachableError(error));
		return error.detail;
	}

	it("prefers the message of an error cause", async () => {
		const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		assert.equal(await detailOf(new TypeError("fetch failed", { cause })), "socket hang up");
	});

	it("uses the code of a cause that is an error with no message", async () => {
		const cause = Object.assign(new Error(""), { code: "ECONNRESET" });
		assert.equal(await detailOf(new TypeError("fetch failed", { cause })), "ECONNRESET");
	});

	it("uses the string code of a cause that is not an error, ignoring its message", async () => {
		const cause = { message: "ignored", code: "ENOTFOUND" };
		assert.equal(await detailOf(new TypeError("fetch failed", { cause })), "ENOTFOUND");
	});

	it("falls back to the failure's own message when the cause has no usable code", async () => {
		for (const cause of [undefined, null, "text", {}, { code: 42 }, { message: "ignored" }]) {
			assert.equal(await detailOf(new TypeError("fetch failed", { cause })), "fetch failed");
		}
	});
});

describe("llama.cpp model event stream request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the API key and the caller's cancellation signal", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
		const controller = new AbortController();

		await new LlamaClient("http://127.0.0.1:8080", "secret-key").watch(() => {}, controller.signal);

		assert.equal(fetchMock.mock.calls.length, 1);
		const [url, init] = fetchMock.mock.calls[0]!;
		assert.equal(String(url), "http://127.0.0.1:8080/models/sse");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-key");
		assert.equal(init?.signal, controller.signal);
	});
});
