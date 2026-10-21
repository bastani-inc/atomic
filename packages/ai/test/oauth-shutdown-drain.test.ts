import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { refreshStoredOAuthCredential } from "../src/auth/resolve.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { drainPendingOAuthRotations, OAUTH_REFRESH_TIMEOUT_MS, OAUTH_SHUTDOWN_DRAIN_MS } from "../src/index.ts";

const PROVIDER = "openai-1";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** `AbortSignal.timeout` is not driven by vitest's fake timers; route it through the faked `setTimeout`. */
function useFakeTimers() {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
		return controller.signal;
	});
}

async function storeWithExpiredLogin() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(PROVIDER, async () => ({
		type: "oauth",
		access: "fake-access-1",
		refresh: "fake-refresh-1",
		expires: 0,
	}));
	return credentials;
}

function fakeOAuth(refresh: OAuthAuth["refresh"]): OAuthAuth {
	return {
		name: "Fake rotating OAuth",
		login: async () => {
			throw new Error("login is not part of this test");
		},
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
}

/** Starts a refresh and lets its caller give up at {@link OAUTH_REFRESH_TIMEOUT_MS} while the exchange keeps running. */
async function refreshWhoseCallerGivesUp(credentials: InMemoryCredentialStore, oauth: OAuthAuth) {
	const caller = refreshStoredOAuthCredential(
		credentials,
		PROVIDER,
		oauth,
		(credential) => Date.now() >= credential.expires,
		new AbortController().signal,
	);
	void caller.catch(() => undefined);
	await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_TIMEOUT_MS);
	await assert.rejects(caller, /OAuth refresh failed for openai-1/);
}

function startDrain() {
	const drain: { result?: boolean } = {};
	void drainPendingOAuthRotations().then((result) => {
		drain.result = result;
	});
	return drain;
}

async function storedRefreshToken(credentials: InMemoryCredentialStore) {
	const credential = await credentials.read(PROVIDER);
	return credential?.type === "oauth" ? credential.refresh : undefined;
}

it("a shutdown drain waits until a rotation its caller gave up on is stored", async () => {
	const responseAfterCallerGaveUpMs = OAUTH_SHUTDOWN_DRAIN_MS / 2;
	useFakeTimers();
	const credentials = await storeWithExpiredLogin();
	const rotated: OAuthCredential = {
		type: "oauth",
		access: "fake-access-2",
		refresh: "fake-refresh-2",
		expires: Date.now() + 3_600_000,
	};
	await refreshWhoseCallerGivesUp(
		credentials,
		fakeOAuth(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve(rotated), OAUTH_REFRESH_TIMEOUT_MS + responseAfterCallerGaveUpMs),
				),
		),
	);

	const drain = startDrain();
	await vi.advanceTimersByTimeAsync(responseAfterCallerGaveUpMs - 1);
	assert.equal(drain.result, undefined, "the drain ended before the exchange settled");
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(drain.result, true);
	assert.equal(await storedRefreshToken(credentials), rotated.refresh);
});

it("a shutdown drain gives up on a hung exchange at OAUTH_SHUTDOWN_DRAIN_MS", async () => {
	useFakeTimers();
	const credentials = await storeWithExpiredLogin();
	await refreshWhoseCallerGivesUp(
		credentials,
		fakeOAuth(() => new Promise<OAuthCredential>(() => {})),
	);

	const drain = startDrain();
	await vi.advanceTimersByTimeAsync(OAUTH_SHUTDOWN_DRAIN_MS - 1);
	assert.equal(drain.result, undefined);
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(drain.result, false);
	assert.equal(await storedRefreshToken(credentials), "fake-refresh-1");
});
