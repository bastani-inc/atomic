import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  normalizeToolArgumentsForModel,
  unflattenGeminiToolArguments,
} from "../src/core/copilot-gemini-tool-arguments.ts";

function geminiModel(): Pick<Model<Api>, "provider" | "api" | "id"> {
  return { provider: "github-copilot", api: "openai-completions", id: "gemini-3.1-pro-preview" };
}

describe("unflattenGeminiToolArguments", () => {
  it("reconstructs a flattened array argument (the observed Gemini shape)", () => {
    const result = unflattenGeminiToolArguments({
      category: "technology",
      confidence: 0.95,
      "keywords[0]": "RAG",
      "keywords[1]": "coding agents",
      "keywords[2]": "LLM",
      summary: "An overview.",
    });
    expect(result).toEqual({
      category: "technology",
      confidence: 0.95,
      keywords: ["RAG", "coding agents", "LLM"],
      summary: "An overview.",
    });
  });

  it("returns the same reference when there are no flattened keys", () => {
    const args = { keywords: ["a", "b"], summary: "s" };
    expect(unflattenGeminiToolArguments(args)).toBe(args);
  });

  it("reconstructs nested objects within flattened arrays", () => {
    const result = unflattenGeminiToolArguments({
      "files[0].path": "a.ts",
      "files[0].status": "modified",
      "files[1].path": "b.ts",
      "files[1].status": "created",
    });
    expect(result).toEqual({
      files: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "created" },
      ],
    });
  });

  it("reconstructs dotted nested object keys", () => {
    const result = unflattenGeminiToolArguments({
      "metadata.confidence": 0.5,
      "metadata.tags[0]": "x",
      name: "n",
    });
    expect(result).toEqual({ metadata: { confidence: 0.5, tags: ["x"] }, name: "n" });
  });

  it("compacts out-of-order indices into a dense array", () => {
    expect(unflattenGeminiToolArguments({ "items[2]": "c", "items[0]": "a", "items[1]": "b" })).toEqual({
      items: ["a", "b", "c"],
    });
  });

  it("leaves non-object values untouched", () => {
    expect(unflattenGeminiToolArguments("nope")).toBe("nope");
    expect(unflattenGeminiToolArguments(null)).toBe(null);
  });
});

describe("normalizeToolArgumentsForModel", () => {
  const flattened = { "keywords[0]": "a", "keywords[1]": "b" };

  it("normalizes for GitHub Copilot Gemini models", () => {
    expect(normalizeToolArgumentsForModel(flattened, geminiModel())).toEqual({ keywords: ["a", "b"] });
  });

  it("is a no-op for other providers/models (returns same reference)", () => {
    expect(normalizeToolArgumentsForModel(flattened, { provider: "google", api: "google-generative-ai", id: "gemini-3.1-pro-preview" })).toBe(flattened);
    expect(normalizeToolArgumentsForModel(flattened, { provider: "github-copilot", api: "anthropic-messages", id: "claude-opus-4.8" })).toBe(flattened);
    expect(normalizeToolArgumentsForModel(flattened, undefined)).toBe(flattened);
  });
});
