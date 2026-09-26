/**
 * Webhook delivery (`src/extensions/webhooks/sender.ts`) against a real local
 * receiver. Issue #2345: three attempts total per destination, finite timeouts,
 * bounded backoff, Retry-After honoured only inside the delivery window,
 * redirects never followed, and no URL, header value, or server response in
 * anything the outcome carries. Every token here is fake; nothing real is ever
 * sent to the receiver.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, test } from "vitest";
import {
	WEBHOOK_RETRY_AFTER_MAX_MS,
	WEBHOOK_RETRY_BACKOFF_MS,
	WEBHOOK_SEND_ATTEMPTS,
} from "../../packages/coding-agent/src/extensions/webhooks/constants.js";
import {
	retryWaitMs,
	sendWebhook,
	type WebhookSendTarget,
} from "../../packages/coding-agent/src/extensions/webhooks/sender.js";

const FAKE_TOKEN = "test-token-not-a-secret";
const NO_WAIT = [0, 0] as const;

interface Seen {
	readonly method: string | undefined;
	readonly url: string | undefined;
	readonly headers: IncomingMessage["headers"];
	readonly body: string;
}

interface Receiver {
	readonly url: string;
	readonly seen: Seen[];
	close(): Promise<void>;
}

/** The idiom from install-powershell.test.ts: an ephemeral port on loopback, `Connection: close` so nothing lingers. */
async function receiver(handle: (seen: Seen, response: ServerResponse) => void): Promise<Receiver> {
	const seen: Seen[] = [];
	const server: Server = createServer((request, response) => {
		response.setHeader("Connection", "close");
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			const record = { method: request.method, url: request.url, headers: request.headers, body };
			seen.push(record);
			handle(record, response);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("receiver did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/hook`,
		seen,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const open: Receiver[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((r) => r.close()));
});

async function start(handle: (seen: Seen, response: ServerResponse) => void): Promise<Receiver> {
	const r = await receiver(handle);
	open.push(r);
	return r;
}

function target(url: string, over: Partial<WebhookSendTarget> = {}): WebhookSendTarget {
	return { url, method: "POST", headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, ...over };
}

const respond =
	(status: number, headers: Record<string, string> = {}) =>
	(_seen: Seen, response: ServerResponse) => {
		response.writeHead(status, headers);
		response.end("receiver body that must never surface");
	};

describe("sendWebhook", () => {
	test("delivers the body verbatim with the destination's method and headers, JSON content type, one attempt", async () => {
		const r = await start(respond(200));
		const body = JSON.stringify({ text: 'quotes "and" newlines\nsurvive' });

		const outcome = await sendWebhook(target(r.url, { method: "PUT", headers: { "X-Custom": "1" } }), body, {
			backoffMs: NO_WAIT,
		});

		assert.deepEqual(outcome, { kind: "accepted", status: 200, attempts: 1 });
		assert.equal(r.seen.length, 1);
		assert.equal(r.seen[0]?.method, "PUT");
		assert.equal(r.seen[0]?.url, "/hook");
		assert.equal(r.seen[0]?.headers["content-type"], "application/json");
		assert.equal(r.seen[0]?.headers["x-custom"], "1");
		assert.equal(r.seen[0]?.body, body);
	});

	test("a transient status is retried and the later success is reported with its attempt count", async () => {
		let calls = 0;
		const r = await start((seen, response) => {
			calls += 1;
			respond(calls === 1 ? 503 : 200)(seen, response);
		});

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: NO_WAIT });

		assert.deepEqual(outcome, { kind: "accepted", status: 200, attempts: 2 });
	});

	test("three transient responses exhaust the attempts; the last status is the failure, nothing more", async () => {
		const r = await start(respond(503));

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: NO_WAIT });

		assert.deepEqual(outcome, {
			kind: "exhausted",
			attempts: WEBHOOK_SEND_ATTEMPTS,
			lastFailure: "HTTP 503",
			lastAttemptTimedOut: false,
		});
		assert.equal(r.seen.length, WEBHOOK_SEND_ATTEMPTS);
	});

	test("a 4xx other than 408 and 429 is rejected on the first attempt", async () => {
		const r = await start(respond(400));

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: NO_WAIT });

		assert.deepEqual(outcome, { kind: "rejected", status: 400, attempts: 1 });
		assert.equal(r.seen.length, 1);
	});

	test("a redirect is never followed: the bearer header must not travel, so 3xx is a rejection", async () => {
		const r = await start((seen, response) => {
			if (seen.url === "/elsewhere") {
				respond(200)(seen, response);
				return;
			}
			response.writeHead(302, { Location: "/elsewhere" });
			response.end();
		});

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: NO_WAIT });

		assert.deepEqual(outcome, { kind: "rejected", status: 302, attempts: 1 });
		assert.deepEqual(
			r.seen.map((s) => s.url),
			["/hook"],
		);
	});

	test("Retry-After on a 429 sets the wait, and a wait that outruns the window stops before it starts", async () => {
		const r = await start(respond(429, { "Retry-After": "3600" }));

		const outcome = await sendWebhook(target(r.url, { timeoutMs: 1_000 }), "{}", {
			backoffMs: NO_WAIT,
			windowMs: 2_000,
		});

		// One attempt made, none in flight when the loop stopped: the count says 1, not 2.
		assert.deepEqual(outcome, {
			kind: "exhausted",
			attempts: 1,
			lastFailure: "HTTP 429",
			lastAttemptTimedOut: false,
		});
		assert.equal(r.seen.length, 1);
	});

	test("Retry-After: 0 retries at once", async () => {
		let calls = 0;
		const r = await start((seen, response) => {
			calls += 1;
			(calls === 1 ? respond(429, { "Retry-After": "0" }) : respond(204))(seen, response);
		});

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: [5_000, 5_000] });

		assert.deepEqual(outcome, { kind: "accepted", status: 204, attempts: 2 });
	});

	test("an attempt that hits its timeout is retried, and an exhausted outcome says the last one timed out", async () => {
		const held: ServerResponse[] = [];
		const r = await start((_seen, response) => {
			held.push(response);
		});

		const outcome = await sendWebhook(target(r.url, { timeoutMs: 100 }), "{}", { backoffMs: NO_WAIT });

		assert.deepEqual(outcome, {
			kind: "exhausted",
			attempts: WEBHOOK_SEND_ATTEMPTS,
			lastFailure: "timed out",
			lastAttemptTimedOut: true,
		});
		assert.equal(held.length, WEBHOOK_SEND_ATTEMPTS);
		for (const response of held) response.end();
	});

	test("the caller's abort is terminal and reported as cancelled", async () => {
		const held: ServerResponse[] = [];
		const r = await start((_seen, response) => {
			held.push(response);
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);

		const outcome = await sendWebhook(target(r.url), "{}", { backoffMs: NO_WAIT, signal: controller.signal });

		assert.deepEqual(outcome, { kind: "cancelled" });
		assert.equal(held.length, 1);
		for (const response of held) response.end();
	});

	test("a refused connection is retried, then described by its errno code with no URL, host, or header value", async () => {
		const closed = await receiver(respond(200));
		await closed.close();

		const outcome = await sendWebhook(target(closed.url), "{}", { backoffMs: NO_WAIT });

		assert.equal(outcome.kind, "exhausted");
		assert.equal(outcome.attempts, WEBHOOK_SEND_ATTEMPTS);
		assert.equal(outcome.lastFailure, "network error (ECONNREFUSED)");
		assert.equal(outcome.lastAttemptTimedOut, false);
		assert.ok(!outcome.lastFailure.includes("127.0.0.1"));
		assert.ok(!outcome.lastFailure.includes(FAKE_TOKEN));
	});
});

describe("retryWaitMs", () => {
	const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

	test("no Retry-After: the backoff entry for the attempt, the last entry past the table's end", () => {
		assert.equal(retryWaitMs(0, null, WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_BACKOFF_MS[0]);
		assert.equal(retryWaitMs(1, null, WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_BACKOFF_MS[1]);
		assert.equal(retryWaitMs(9, null, WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_BACKOFF_MS[1]);
		assert.equal(retryWaitMs(0, null, [], NOW), 0);
	});

	test("Retry-After in seconds, including fractions, wins over the backoff", () => {
		assert.equal(retryWaitMs(0, "2", WEBHOOK_RETRY_BACKOFF_MS, NOW), 2_000);
		assert.equal(retryWaitMs(0, "0.5", WEBHOOK_RETRY_BACKOFF_MS, NOW), 500);
		assert.equal(retryWaitMs(0, "0", WEBHOOK_RETRY_BACKOFF_MS, NOW), 0);
	});

	test("Retry-After as an HTTP date is measured from now, and a date in the past means no wait", () => {
		const future = new Date(NOW + 4_000).toUTCString();
		const past = new Date(NOW - 4_000).toUTCString();
		assert.equal(retryWaitMs(0, future, WEBHOOK_RETRY_BACKOFF_MS, NOW), 4_000);
		assert.equal(retryWaitMs(0, past, WEBHOOK_RETRY_BACKOFF_MS, NOW), 0);
	});

	test("a Retry-After beyond the cap is clamped to the cap", () => {
		assert.equal(retryWaitMs(0, "3600", WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_AFTER_MAX_MS);
		const farFuture = new Date(NOW + 10 * WEBHOOK_RETRY_AFTER_MAX_MS).toUTCString();
		assert.equal(retryWaitMs(0, farFuture, WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_AFTER_MAX_MS);
	});

	test("an unparseable Retry-After falls back to the backoff for that attempt", () => {
		assert.equal(retryWaitMs(1, "soon", WEBHOOK_RETRY_BACKOFF_MS, NOW), WEBHOOK_RETRY_BACKOFF_MS[1]);
	});
});
