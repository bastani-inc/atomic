import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, vi } from "vitest";
import { LlamaClient } from "../src/extensions/llama/client.js";
import {
	findLlamaServerError,
	isLlamaServerError,
	isLlamaServerRequestError,
	isLlamaServerUnreachableError,
	isRetryableLlamaServerError,
	LlamaServerError,
	LlamaServerRequestError,
	LlamaServerUnreachableError,
	rehydrateLlamaServerError,
} from "../src/extensions/llama/errors.js";

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

	it("reports a server URL with a user name and password as a rejected request without leaking them", async () => {
		const port = await closedPort();
		const error = await new LlamaClient(`http://alice:s3cr3t@127.0.0.1:${port}`).list().then(
			() => undefined,
			(failure: unknown) => failure,
		);

		assert.ok(error instanceof LlamaServerRequestError);
		assert.ok(isLlamaServerRequestError(error));
		assert.ok(isLlamaServerError(error));
		assert.equal(isLlamaServerUnreachableError(error), false);
		assert.equal(error.name, "LlamaServerRequestError");
		assert.equal(error.code, "request-rejected");
		assert.equal(error.retryable, false);
		assert.equal(error.serverUrl, `http://127.0.0.1:${port}`);
		assert.ok(error.hint?.includes("without a user name or password"));
		assert.ok(error.cause instanceof TypeError);
		for (const text of [error.message, error.detail, JSON.stringify(error.toJSON())]) {
			assert.equal(text.includes("s3cr3t"), false, text);
			assert.equal(text.includes("alice"), false, text);
		}
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

	it("removes credentials from a server URL that cannot be parsed, in every constructor", () => {
		const unparsable = "http://alice:s3cr3t@exa mple:8080";
		const errors: LlamaServerError[] = [
			new LlamaServerUnreachableError(unparsable, "connect ECONNREFUSED"),
			new LlamaServerRequestError(unparsable, "rejected"),
			new LlamaServerError("boom", { code: "server-unreachable", serverUrl: unparsable, retryable: true }),
			rehydrateLlamaServerError({
				name: "LlamaServerUnreachableError",
				code: "server-unreachable",
				message: "x",
				retryable: true,
				fields: { serverUrl: unparsable, detail: "connect ECONNREFUSED" },
			}),
		];
		for (const error of errors) {
			assert.equal(error.serverUrl, "http://exa mple:8080");
			for (const text of [error.message, JSON.stringify(error.toJSON())]) {
				assert.equal(text.includes("s3cr3t"), false, text);
				assert.equal(text.includes("alice"), false, text);
			}
		}
	});

	it("removes credentials from an unparsable server URL with leading whitespace or any valid scheme", () => {
		const cases = [
			[" http://alice:s3cr3t@exa mple:8080", " http://exa mple:8080"],
			["s3://alice:s3cr3t@bu cket", "s3://bu cket"],
			["x://alice:s3cr3t@h h", "x://h h"],
			["http://alice:pa ss@s3cr3t@h x/y@z", "http://h x/y@z"],
		] as const;
		for (const [serverUrl, displayed] of cases) {
			const error = new LlamaServerUnreachableError(serverUrl, "connect ECONNREFUSED");
			assert.equal(error.serverUrl, displayed, serverUrl);
			assert.equal(JSON.stringify(error.toJSON()).includes("s3cr3t"), false, serverUrl);
		}
	});

	it("removes a password that contains a raw @ from the server URL and the detail", () => {
		const error = new LlamaServerRequestError("http://user:p@ss@host:8080", "bad url http://user:p@ss@host:8080/x");
		assert.equal(error.serverUrl, "http://host:8080");
		assert.equal(error.detail, "bad url http://host:8080/x");
		assert.equal(JSON.stringify(error.toJSON()).includes("ss@"), false);
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

	it("matches a concrete class only with its own code", () => {
		const unreachableName = { name: "LlamaServerUnreachableError", code: "request-rejected" };
		const requestName = { name: "LlamaServerRequestError", code: "server-unreachable" };
		assert.equal(isLlamaServerUnreachableError(unreachableName), false);
		assert.equal(isLlamaServerRequestError(requestName), false);
		assert.equal(
			isLlamaServerUnreachableError({ name: "LlamaServerUnreachableError", code: "server-unreachable" }),
			true,
		);
		assert.equal(isLlamaServerRequestError({ name: "LlamaServerRequestError", code: "request-rejected" }), true);
		for (const code of ["server-unreachable", "request-rejected"]) {
			assert.equal(isLlamaServerError({ name: "LlamaServerError", code }), true, code);
		}
		assert.equal(isLlamaServerError(unreachableName), true);
		assert.equal(isLlamaServerError(requestName), true);
	});

	it("rehydrates a name and code that do not belong together into the base with both kept", () => {
		const rehydrated = rehydrateLlamaServerError({
			name: "LlamaServerUnreachableError",
			code: "request-rejected",
			message: "rejected at http://alice:s3cr3t@127.0.0.1:8080",
			retryable: false,
			fields: { serverUrl: "http://127.0.0.1:8080", detail: "rejected" },
		});
		assert.equal(rehydrated instanceof LlamaServerUnreachableError, false);
		assert.ok(rehydrated instanceof LlamaServerError);
		assert.equal(rehydrated.name, "LlamaServerUnreachableError");
		assert.equal(rehydrated.code, "request-rejected");
		assert.equal(rehydrated.retryable, false);
		assert.equal(rehydrated.message, "rejected at http://127.0.0.1:8080");

		const mirrored = rehydrateLlamaServerError({
			name: "LlamaServerRequestError",
			code: "server-unreachable",
			message: "x",
			retryable: true,
			fields: { serverUrl: "http://127.0.0.1:8080" },
		});
		assert.equal(mirrored instanceof LlamaServerRequestError, false);
		assert.equal(mirrored.name, "LlamaServerRequestError");
		assert.equal(mirrored.code, "server-unreachable");
	});

	it("tells by code whether an error or a llama error in its cause chain may be retried", () => {
		const unreachable = new LlamaServerUnreachableError("http://127.0.0.1:8080", "connect ECONNREFUSED");
		const rejected = new LlamaServerRequestError("http://127.0.0.1:8080", "bad port");
		assert.equal(isRetryableLlamaServerError(unreachable), true);
		assert.equal(isRetryableLlamaServerError(rejected), false);
		assert.equal(isRetryableLlamaServerError(new Error("Failed to save API key", { cause: unreachable })), true);
		assert.equal(isRetryableLlamaServerError(new Error("Failed to save API key", { cause: rejected })), false);
		assert.equal(isRetryableLlamaServerError(new Error("connect ECONNREFUSED")), false);
		assert.equal(isRetryableLlamaServerError(undefined), false);
		assert.equal(isRetryableLlamaServerError(rehydrateLlamaServerError(unreachable.toJSON())), true);
		assert.equal(isRetryableLlamaServerError(rehydrateLlamaServerError(rejected.toJSON())), false);
		assert.equal(
			isRetryableLlamaServerError({ name: "LlamaServerUnreachableError", code: "server-unreachable" }),
			true,
		);
		assert.equal(
			isRetryableLlamaServerError({ name: "LlamaServerError", code: "request-rejected", retryable: true }),
			false,
		);
		for (const code of ["other", "toString", "__proto__"]) {
			const relayedUnknownCode = rehydrateLlamaServerError({
				name: "LlamaServerError",
				code,
				message: "x",
				retryable: true,
				fields: { serverUrl: "http://127.0.0.1:8080" },
			});
			assert.equal(relayedUnknownCode.code, code);
			assert.equal(isRetryableLlamaServerError(relayedUnknownCode), false, code);
		}
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

	it("treats a failure that carries an error code as unreachable", async () => {
		const failure = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
			code: "ConnectionRefused",
		});
		assert.equal(await detailOf(failure), "Unable to connect. Is the computer able to access the url?");
	});
});

describe("llama.cpp request failures that are not network failures", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function failureOf(rejection: unknown): Promise<unknown> {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(rejection);
		return new LlamaClient("http://127.0.0.1:8080").list().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
	}

	it("reports a fetch failure whose chain has no error code as a rejected request with the failure's message", async () => {
		for (const cause of [undefined, null, "text", {}, { code: 42 }, { message: "ignored" }]) {
			const error = await failureOf(new TypeError("fetch failed", { cause }));
			assert.ok(isLlamaServerRequestError(error), String(cause));
			assert.equal(error.code, "request-rejected");
			assert.equal(error.retryable, false);
			assert.equal(error.detail, "fetch failed");
		}
	});

	it("reports a port that fetch blocks as a rejected request, not an unreachable server", async () => {
		const error = await failureOf(new TypeError("fetch failed", { cause: new Error("bad port") }));
		assert.ok(isLlamaServerRequestError(error));
		assert.equal(error.retryable, false);
		assert.equal(error.detail, "bad port");
		assert.ok(error.hint?.includes("does not block"));
	});

	it("reports a failure without an error code as a rejected request that is not retried", async () => {
		const error = await failureOf(new TypeError("Invalid header value for http://bob:hunter2@127.0.0.1:8080/x"));
		assert.ok(isLlamaServerRequestError(error));
		assert.equal(error.code, "request-rejected");
		assert.equal(error.retryable, false);
		assert.equal(error.detail, "Invalid header value for http://127.0.0.1:8080/x");
	});

	it("rethrows the request timeout unchanged", async () => {
		const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
		assert.equal(await failureOf(timeout), timeout);
	});

	it("rethrows an abort unchanged", async () => {
		const abort = new DOMException("This operation was aborted", "AbortError");
		assert.equal(await failureOf(abort), abort);
	});

	it("round-trips a rejected request across a process boundary with the credentials removed", () => {
		const error = new LlamaServerRequestError("http://alice:s3cr3t@127.0.0.1:8080", "bad url http://alice:s3cr3t@x", {
			cause: new TypeError(
				"Request cannot be constructed from a URL that includes credentials: http://alice:s3cr3t@x",
			),
		});
		const serialized = error.toJSON();
		assert.deepEqual(serialized, {
			name: "LlamaServerRequestError",
			code: "request-rejected",
			message: error.message,
			hint: error.hint,
			retryable: false,
			fields: { serverUrl: "http://127.0.0.1:8080", detail: "bad url http://x" },
			cause: {
				name: "TypeError",
				message: "Request cannot be constructed from a URL that includes credentials: http://x",
			},
		});
		// The one rendered-message contract check for this class.
		assert.equal(
			error.message,
			`Could not send a request to llama.cpp server at http://127.0.0.1:8080: bad url http://x (request-rejected). ${error.hint}`,
		);
		const rehydrated = rehydrateLlamaServerError(JSON.parse(JSON.stringify(serialized)));
		assert.ok(rehydrated instanceof LlamaServerRequestError);
		assert.ok(isLlamaServerRequestError(rehydrated));
		assert.equal(rehydrated.detail, "bad url http://x");
		assert.equal(rehydrated.retryable, false);
		assert.equal(rehydrated.message, error.message);
		assert.equal(
			(rehydrated.cause as Error).message,
			"Request cannot be constructed from a URL that includes credentials: http://x",
		);
		assert.equal(new LlamaServerRequestError("http://127.0.0.1:8080", "bad url").cause, undefined);
		assert.equal(isLlamaServerRequestError({ name: "LlamaServerRequestError", code: "request-rejected" }), true);
		assert.equal(isLlamaServerError({ name: "LlamaServerRequestError", code: "request-rejected" }), true);
		assert.equal(
			isLlamaServerRequestError({ name: "LlamaServerUnreachableError", code: "server-unreachable" }),
			false,
		);
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
