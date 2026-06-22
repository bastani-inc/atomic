import { describe, expect, it } from "vitest";
import {
	formatAuthStorageLoadFailedMessage,
	formatNoApiKeyFoundMessage,
	formatUnresolvedModelMessage,
} from "../src/core/auth-guidance.ts";

describe("formatNoApiKeyFoundMessage", () => {
	it("never renders a literal 'undefined' provider", () => {
		const message = formatNoApiKeyFoundMessage(undefined);
		expect(message).toContain("No API key found for the selected model.");
		expect(message).not.toContain("undefined");
	});

	it("falls back to a friendly target for an empty provider", () => {
		expect(formatNoApiKeyFoundMessage("")).toContain("No API key found for the selected model.");
	});

	it("falls back to a friendly target for the sentinel 'unknown' provider", () => {
		expect(formatNoApiKeyFoundMessage("unknown")).toContain("No API key found for the selected model.");
	});

	it("names a real provider", () => {
		expect(formatNoApiKeyFoundMessage("anthropic")).toContain("No API key found for anthropic.");
	});
});

describe("formatAuthStorageLoadFailedMessage", () => {
	it("describes a load failure (not a missing key) and surfaces the cause", () => {
		const message = formatAuthStorageLoadFailedMessage("anthropic", new Error("Lock file is already being held"));
		expect(message).toContain("Could not load stored credentials for anthropic");
		expect(message).toContain("Lock file is already being held");
		expect(message).not.toContain("No API key found");
		expect(message).toContain("/login anthropic");
	});

	it("stays classifiable as an auth failure by mentioning 'API key'", () => {
		// The workflows model-fallback classifier keys on 'api key'/'auth' to treat
		// a failure as recoverable/retryable; the load-failure message must keep
		// that property so a transient store-read failure is not turned into a hard
		// task failure (issue #1431).
		const message = formatAuthStorageLoadFailedMessage("openai-codex", new Error("ELOCKED"));
		expect(message).toContain("API key");
	});

	it("never renders a literal 'undefined' provider and omits the login hint", () => {
		const message = formatAuthStorageLoadFailedMessage(undefined, new Error("boom"));
		expect(message).toContain("the selected model");
		expect(message).not.toContain("undefined");
		// The per-provider re-auth hint is omitted (the generic /login help still shows).
		expect(message).not.toContain("to re-authenticate");
	});

	it("treats the sentinel 'unknown' provider as unnamed", () => {
		const message = formatAuthStorageLoadFailedMessage("unknown", new Error("boom"));
		expect(message).toContain("the selected model");
		expect(message).not.toContain("to re-authenticate");
	});
});

describe("formatUnresolvedModelMessage", () => {
	it("reads as an 'unknown model' error and names a string model id", () => {
		const message = formatUnresolvedModelMessage("openai/ghost");
		expect(message).toContain('Unknown model: "openai/ghost"');
		expect(message).toContain("did not resolve to an available provider");
		expect(message).not.toContain("undefined");
	});

	it("names an object model's id when present", () => {
		expect(formatUnresolvedModelMessage({ id: "ghost" })).toContain('Unknown model: "ghost"');
	});

	it("falls back to a friendly target for unidentifiable models", () => {
		expect(formatUnresolvedModelMessage(undefined)).toContain("Unknown model: the selected model");
		expect(formatUnresolvedModelMessage({})).toContain("Unknown model: the selected model");
	});
});
