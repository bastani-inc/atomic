import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	DEFAULT_ACCESS_TOKEN_LIFETIME_MS,
	oauthTokenExpiry,
	refreshedOAuthCredential,
} from "../src/auth/oauth/token-response.ts";

const NOW = Date.parse("2026-11-15T00:00:00Z");
const SKEW_MS = 5 * 60 * 1000;

/** A JWT whose payload is `payload` (JSON text) encoded as base64url without padding. */
function rawJwt(payload: string): string {
	return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(payload).toString("base64url")}.signature`;
}

function jwt(claims: object): string {
	return rawJwt(JSON.stringify(claims));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshed OAuth credential", () => {
	it("keeps the presented refresh token when the response issues none (#4959)", () => {
		for (const refresh_token of [undefined, "", null, 42]) {
			const credential = refreshedOAuthCredential("access", { refresh_token, expires_in: 60 }, "R0", 0);
			assert.deepEqual(credential, { type: "oauth", access: "access", refresh: "R0", expires: NOW + 60_000 });
		}
	});

	it("stores a rotated refresh token (#4959)", () => {
		const credential = refreshedOAuthCredential("access", { refresh_token: "R1", expires_in: 60 }, "R0", 0);
		assert.equal(credential.refresh, "R1");
	});

	it("takes the expiry from expires_in less the skew (#4959)", () => {
		assert.equal(oauthTokenExpiry("access", 3600, SKEW_MS), NOW + 3_600_000 - SKEW_MS);
		assert.equal(oauthTokenExpiry(jwt({ exp: NOW / 1000 + 60 }), 3600, SKEW_MS), NOW + 3_600_000 - SKEW_MS);
	});

	it("takes the expiry from a JWT access token's exp when expires_in is missing or unusable (#4959)", () => {
		const exp = NOW / 1000 + 7200;
		for (const expiresIn of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "3600"]) {
			assert.equal(oauthTokenExpiry(jwt({ exp }), expiresIn, SKEW_MS), exp * 1000 - SKEW_MS);
		}
		// Payload bytes that encode to base64url-only characters ("-" and "_") and need padding.
		const awkward = jwt({ exp, note: "\u00fb\u00ff>?~" });
		assert.match(awkward.split(".")[1] ?? "", /[-_]/);
		assert.equal(oauthTokenExpiry(awkward, undefined, 0), exp * 1000);
	});

	it("assumes the default lifetime for an opaque token without expires_in, never NaN (#4959)", () => {
		const fallback = NOW + DEFAULT_ACCESS_TOKEN_LIFETIME_MS - SKEW_MS;
		assert.equal(DEFAULT_ACCESS_TOKEN_LIFETIME_MS, 60 * 60 * 1000);
		for (const access of [
			"opaque-token",
			"a.b",
			"a.b.c.d",
			"a..c",
			"a.not-json.c",
			jwt({ exp: "soon" }),
			jwt({ exp: null }),
			jwt({ sub: "x" }),
			rawJwt('{"exp":1e999}'),
			rawJwt("null"),
		]) {
			assert.equal(oauthTokenExpiry(access, undefined, SKEW_MS), fallback, access);
		}
	});
});
