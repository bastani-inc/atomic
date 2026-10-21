import type { ProviderHeaders } from "@bastani/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { mergeHeaders } from "../src/core/model-runtime-streaming.ts";

// These tests exercise the pi-ai 0.80.2 ProviderHeaders null-suppression contract
// directly against the merged request headers, without spinning up a full
// AgentSession: a `null` value tells pi-ai to drop its own default header.
describe("mergeHeaders — ProviderHeaders null preservation", () => {
	it("forwards a null header value verbatim instead of collapsing it", () => {
		const merged = mergeHeaders(undefined, { "User-Agent": null } satisfies ProviderHeaders);

		// null must be preserved so pi-ai can suppress its own default User-Agent;
		// it must NOT become undefined or be dropped from the object.
		expect(merged).toBeDefined();
		expect(merged?.["User-Agent"]).toBeNull();
		expect("User-Agent" in (merged as object)).toBe(true);
	});

	it("does not collapse null to undefined when mixed with string values", () => {
		const merged = mergeHeaders(undefined, {
			"X-Keep": "yes",
			"X-Suppress": null,
		} satisfies ProviderHeaders);

		expect(merged?.["X-Keep"]).toBe("yes");
		expect(merged?.["X-Suppress"]).toBeNull();
		expect(merged?.["X-Suppress"]).not.toBeUndefined();
	});

	it("preserves null even when it is the only header (result is non-empty)", () => {
		const merged = mergeHeaders(undefined, { Authorization: null } satisfies ProviderHeaders);

		// A lone null is a real suppression directive; the merged object must be
		// returned (not collapsed to undefined) so pi-ai receives it.
		expect(merged).toBeDefined();
		expect(merged?.Authorization).toBeNull();
	});

	it("lets a later null override an earlier string value for the same (case-insensitive) header", () => {
		const merged = mergeHeaders(
			{ "X-Trace-Id": "abc-123" } satisfies ProviderHeaders,
			{
				"x-trace-id": null,
			} satisfies ProviderHeaders,
		);

		// The later null must win and remain null, not retain the earlier string.
		expect(merged?.["x-trace-id"]).toBeNull();
		expect(merged?.["X-Trace-Id"]).toBeUndefined();
	});

	it("lets a later string override an earlier null for the same header", () => {
		const merged = mergeHeaders(
			{ "X-Trace-Id": null } satisfies ProviderHeaders,
			{
				"X-Trace-Id": "abc-123",
			} satisfies ProviderHeaders,
		);

		expect(merged?.["X-Trace-Id"]).toBe("abc-123");
	});
});
