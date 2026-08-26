import { expect, test } from "vitest";
import { llamaCppPostLoginGuidance } from "../src/modes/interactive/interactive-auth-login.ts";

test("directs llama.cpp login to load a model before selecting one", () => {
	expect(llamaCppPostLoginGuidance("Saved API key for llama.cpp", 0)).toBe(
		"Saved API key for llama.cpp. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.",
	);
});

test("directs llama.cpp login to model selection when models are loaded", () => {
	expect(llamaCppPostLoginGuidance("Saved API key for llama.cpp", 2)).toBe(
		"Saved API key for llama.cpp. Use /model to select a loaded llama.cpp model, or /llama to manage models.",
	);
});
