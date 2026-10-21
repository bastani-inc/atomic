import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { refreshStoredOAuthCredential } from "../src/auth/resolve.ts";
import type { Credential, OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import {
	drainPendingOAuthRotations,
	OAUTH_REFRESH_LOCK_HOLD_MS,
	OAUTH_REFRESH_TIMEOUT_MS,
	OAUTH_SHUTDOWN_DRAIN_MS,
	OAuthRefreshRejectedError,
} from "../src/index.ts";

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

/** How long after the lock hold ends the late token exchange answers in the unsaved-rotation tests. */
const LATE_RESPONSE_AFTER_LOCK_HOLD_MS = OAUTH_SHUTDOWN_DRAIN_MS / 2;
const FAKE_TOKENS = ["fake-access-1", "fake-refresh-1", "fake-access-2", "fake-refresh-2"];

/** A store whose lock cannot be taken when saving the rotated `fake-refresh-2` login. */
class StoreThatCannotSaveRotation extends InMemoryCredentialStore {
	override modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: Parameters<InMemoryCredentialStore["modify"]>[2],
	): Promise<Credential | undefined> {
		return super.modify(
			providerId,
			async (current) => {
				const next = await fn(current);
				if (next?.type === "oauth" && next.refresh === "fake-refresh-2") {
					throw Object.assign(new Error("lock file /home/me/.atomic/auth.json.lock held (fake-refresh-2)"), {
						code: "ELOCKED",
					});
				}
				return next;
			},
			options,
		);
	}
}

/**
 * The first exchange answers {@link LATE_RESPONSE_AFTER_LOCK_HOLD_MS} after the lock hold with `lateResult`; the
 * provider then rejects the still-stored `fake-refresh-1` with `invalid_grant`.
 */
async function lateExchangeThenRejectedRefresh(lateResult: () => Promise<OAuthCredential>) {
	useFakeTimers();
	const credentials = new StoreThatCannotSaveRotation();
	await credentials.modify(PROVIDER, async () => ({
		type: "oauth",
		access: "fake-access-1",
		refresh: "fake-refresh-1",
		expires: 0,
	}));
	let exchanges = 0;
	const oauth = fakeOAuth(async (presented) => {
		exchanges++;
		if (exchanges === 1) {
			await new Promise((resolve) => setTimeout(resolve, OAUTH_REFRESH_LOCK_HOLD_MS + LATE_RESPONSE_AFTER_LOCK_HOLD_MS));
			return lateResult();
		}
		throw new OAuthRefreshRejectedError(
			"Token refresh failed",
			{ status: 400, code: "invalid_grant", description: "refresh token already used" },
			[presented.refresh, presented.access],
		);
	});
	await refreshWhoseCallerGivesUp(credentials, oauth);
	await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_LOCK_HOLD_MS - OAUTH_REFRESH_TIMEOUT_MS);
	await vi.advanceTimersByTimeAsync(LATE_RESPONSE_AFTER_LOCK_HOLD_MS);
	assert.equal(exchanges, 1);
	assert.equal(await storedRefreshToken(credentials), "fake-refresh-1");

	const next = refreshStoredOAuthCredential(
		credentials,
		PROVIDER,
		oauth,
		(credential) => Date.now() >= credential.expires,
		new AbortController().signal,
	);
	const error = await next.then(
		() => assert.fail("the provider rejected the refresh"),
		(rejected: unknown) => rejected,
	);
	assert.ok(error instanceof Error);
	return error.message;
}

it("a rejected refresh explains that an earlier rotation could not be saved", async () => {
	const message = await lateExchangeThenRejectedRefresh(async () => ({
		type: "oauth",
		access: "fake-access-2",
		refresh: "fake-refresh-2",
		expires: Date.now() + 3_600_000,
	}));

	assert.match(message, /invalid_grant/);
	assert.match(
		message,
		/An earlier refresh for openai-1 succeeded, but its new login could not be saved \(ELOCKED\)\./,
	);
	assert.match(message, /run \/login openai-1/);
	for (const token of FAKE_TOKENS) assert.equal(message.includes(token), false, `message leaks ${token}`);
	assert.equal(message.includes("auth.json.lock"), false, "message leaks the save error's text");
});

it("a late exchange that itself fails leaves no unsaved-rotation note", async () => {
	const message = await lateExchangeThenRejectedRefresh(async () => {
		throw new Error("network down");
	});

	assert.match(message, /invalid_grant/);
	assert.match(message, /run \/login openai-1/);
	assert.equal(message.includes("could not be saved"), false);
});
