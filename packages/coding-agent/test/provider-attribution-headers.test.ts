import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// These tests exercise the pi-ai 0.80.2 ProviderHeaders null-suppression contract
// directly against the merged attribution output, without spinning up a full
// AgentSession. The model below is a generic non-attribution model so the only
// contributors to the merged output are the variadic header sources.
function createGenericModel(): Model<Api> {
	return {
		id: "generic-test-model",
		name: "Generic Test Model",
		api: "openai-completions",
		provider: "generic",
		baseUrl: "https://generic.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("mergeProviderAttributionHeaders — ProviderHeaders null preservation", () => {
	let tempDir: string;
	let settingsManager: SettingsManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-provider-attribution-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "project"), { recursive: true });
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		settingsManager = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("forwards a null header value verbatim instead of collapsing it", () => {
		const merged = mergeProviderAttributionHeaders(
			createGenericModel(),
			settingsManager,
			undefined,
			{ "User-Agent": null } satisfies ProviderHeaders,
		);

		// null must be preserved so pi-ai can suppress its own default User-Agent;
		// it must NOT become undefined or be dropped from the object.
		expect(merged).toBeDefined();
		expect(merged?.["User-Agent"]).toBeNull();
		expect("User-Agent" in (merged as object)).toBe(true);
	});

	it("does not collapse null to undefined when mixed with string values", () => {
		const merged = mergeProviderAttributionHeaders(
			createGenericModel(),
			settingsManager,
			undefined,
			{ "X-Keep": "yes", "X-Suppress": null } satisfies ProviderHeaders,
		);

		expect(merged?.["X-Keep"]).toBe("yes");
		expect(merged?.["X-Suppress"]).toBeNull();
		expect(merged?.["X-Suppress"]).not.toBeUndefined();
	});

	it("preserves null even when it is the only header (result is non-empty)", () => {
		const merged = mergeProviderAttributionHeaders(
			createGenericModel(),
			settingsManager,
			undefined,
			{ "Authorization": null } satisfies ProviderHeaders,
		);

		// A lone null is a real suppression directive; the merged object must be
		// returned (not collapsed to undefined) so pi-ai receives it.
		expect(merged).toBeDefined();
		expect(merged?.["Authorization"]).toBeNull();
	});

	it("lets a later null override an earlier string value for the same (case-insensitive) header", () => {
		const merged = mergeProviderAttributionHeaders(
			createGenericModel(),
			settingsManager,
			undefined,
			{ "X-Trace-Id": "abc-123" } satisfies ProviderHeaders,
			{ "x-trace-id": null } satisfies ProviderHeaders,
		);

		// The later null must win and remain null, not retain the earlier string.
		expect(merged?.["x-trace-id"]).toBeNull();
		expect(merged?.["X-Trace-Id"]).toBeUndefined();
	});

	it("lets a later string override an earlier null for the same header", () => {
		const merged = mergeProviderAttributionHeaders(
			createGenericModel(),
			settingsManager,
			undefined,
			{ "X-Trace-Id": null } satisfies ProviderHeaders,
			{ "X-Trace-Id": "abc-123" } satisfies ProviderHeaders,
		);

		expect(merged?.["X-Trace-Id"]).toBe("abc-123");
	});
});
