import { describe, expect, it } from "vitest";
import {
	isOAuthLoginCancelled,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
} from "../src/core/oauth-login.ts";

describe("OAuth cancellation normalization", () => {
	it("recognizes exact cancellation, AbortError causes, and active signals", () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		expect(isOAuthLoginCancelled(controller.signal.reason, controller.signal)).toBe(true);
		expect(isOAuthLoginCancelled(new Error("Login cancelled"))).toBe(true);
		expect(isOAuthLoginCancelled(new Error("wrapped", { cause: new DOMException("aborted", "AbortError") }))).toBe(true);
	});

	it("does not classify ordinary failures or completed-transaction failures as cancellation", () => {
		expect(isOAuthLoginCancelled(new Error("provider failed"))).toBe(false);
		expect(isOAuthLoginCancelled(new OAuthLoginTransactionError(new DOMException("aborted", "AbortError")))).toBe(false);
	});

	it("normalizes cancellation while preserving the native cause", () => {
		const cause = new DOMException("aborted", "AbortError");
		const normalized = normalizeOAuthLoginError(cause);
		expect(normalized).toBeInstanceOf(Error);
		expect((normalized as Error).message).toBe("Login cancelled");
		expect((normalized as Error).cause).toBe(cause);
	});

	it("preserves genuine provider and persistence failures", () => {
		const providerFailure = new Error("provider failed");
		expect(normalizeOAuthLoginError(providerFailure)).toBe(providerFailure);
		const persistenceFailure = new OAuthLoginTransactionError(new DOMException("aborted", "AbortError"));
		expect(normalizeOAuthLoginError(persistenceFailure)).toBe(persistenceFailure);
	});
});
