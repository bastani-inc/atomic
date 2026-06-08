import { describe, expect, it } from "vitest";
import {
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
