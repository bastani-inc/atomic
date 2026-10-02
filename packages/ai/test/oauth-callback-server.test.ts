import assert from "node:assert/strict";
import { test } from "vitest";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";

const options = { providerName: "Test", host: "127.0.0.1", port: 0, path: "/callback", state: "expected" };

test("shared OAuth callback rejects wrong state without claiming the sign-in", async () => {
	const callback = await startOAuthCallbackServer({ ...options, complete: async (code) => code });
	try {
		assert.equal((await fetch(`${callback.redirectUri}?code=bad&state=wrong`)).status, 400);
		const response = await fetch(`${callback.redirectUri}?code=good&state=expected`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(await callback.wait(), "good");
		assert.equal((await fetch(`${callback.redirectUri}?code=again&state=expected`)).status, 409);
	} finally {
		callback.close();
	}
});

test("shared OAuth callback pages show the Atomic logo in the accent color", async () => {
	const callback = await startOAuthCallbackServer({ ...options, complete: async (code) => code });
	try {
		const body = await (await fetch(`${callback.redirectUri}?code=good&state=expected`)).text();
		assert.match(body, /<text[^>]*fill="#89b4fa"[^>]*>∀<\/text>/);
		assert.doesNotMatch(body, /fill="#fff"/);
		await callback.wait();
	} finally {
		callback.close();
	}
});

test("shared OAuth callback surfaces token-exchange failure in the browser and login", async () => {
	const callback = await startOAuthCallbackServer({
		...options,
		complete: async () => {
			throw new Error("exchange failed");
		},
	});
	try {
		const response = await fetch(`${callback.redirectUri}?code=good&state=expected`);
		assert.equal(response.status, 502);
		assert.match(await response.text(), /exchange failed/);
		await assert.rejects(callback.wait(), /exchange failed/);
	} finally {
		callback.close();
	}
});

test("shared OAuth callback aborts pending login", async () => {
	const controller = new AbortController();
	const callback = await startOAuthCallbackServer({
		...options,
		signal: controller.signal,
		complete: async (code) => code,
	});
	try {
		controller.abort();
		await assert.rejects(callback.wait(), /Login cancelled/);
	} finally {
		callback.close();
	}
});

test("shared OAuth callback cancels when aborted before awaited startup completes", async () => {
	const controller = new AbortController();
	const pending = startOAuthCallbackServer({
		...options,
		signal: controller.signal,
		complete: async (code) => code,
	});
	controller.abort();
	const callback = await pending;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await assert.rejects(
			Promise.race([
				callback.wait(),
				new Promise((_, reject) => {
					deadline = setTimeout(() => reject(new Error("Cancellation left callback pending")), 1000);
				}),
			]),
			/Login cancelled/,
		);
	} finally {
		clearTimeout(deadline);
		callback.close();
	}
});

test("shared OAuth callback rejects an already-cancelled login before binding", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		startOAuthCallbackServer({ ...options, signal: controller.signal, complete: async (code) => code }),
		/Login cancelled/,
	);
});
