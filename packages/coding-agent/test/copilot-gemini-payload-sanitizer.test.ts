import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DROPPED_SCHEMA_KEYWORDS,
  isCopilotGeminiModel,
  sanitizeCopilotGeminiPayload,
  sanitizeGeminiSchema,
} from "../src/core/copilot-gemini-payload-sanitizer.ts";
import { WorkflowParametersSchema } from "../../workflows/src/extension/workflow-schema.ts";

function geminiModel(id = "gemini-3.1-pro-preview"): Model<Api> {
  return {
    id,
    name: "Gemini",
    provider: "github-copilot",
    api: "openai-completions",
    baseUrl: "https://api.individual.githubcopilot.com",
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ["text", "image"],
    output: ["text"],
    reasoning: "high",
  } as Model<Api>;
}

type JsonObject = Record<string, unknown>;

function functionTool(name: string, parameters: unknown): JsonObject {
  return { type: "function", function: { name, description: name, parameters } };
}

/** Recursively collect every schema node reachable from a root. */
function walk(node: unknown, visit: (n: JsonObject) => void): void {
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit);
    return;
  }
  if (node && typeof node === "object") {
    visit(node as JsonObject);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

function hasUnionWithObjectBranch(root: unknown): boolean {
  let found = false;
  walk(root, (n) => {
    const union = (n.anyOf ?? n.oneOf) as unknown;
    if (Array.isArray(union)) {
      for (const branch of union) {
        if (
          branch &&
          typeof branch === "object" &&
          ((branch as JsonObject).type === "object" ||
            (branch as JsonObject).type === "array" ||
            "properties" in (branch as JsonObject) ||
            "items" in (branch as JsonObject))
        ) {
          found = true;
        }
      }
    }
  });
  return found;
}

describe("isCopilotGeminiModel", () => {
  it("matches GitHub Copilot Gemini openai-completions models", () => {
    expect(isCopilotGeminiModel(geminiModel())).toBe(true);
    expect(isCopilotGeminiModel(geminiModel("gemini-3.5-flash"))).toBe(true);
  });

  it("does not match other providers, apis, or model families", () => {
    expect(isCopilotGeminiModel({ provider: "google", api: "google-generative-ai", id: "gemini-3.1-pro-preview" })).toBe(false);
    expect(isCopilotGeminiModel({ provider: "github-copilot", api: "anthropic-messages", id: "claude-opus-4.8" })).toBe(false);
    expect(isCopilotGeminiModel({ provider: "github-copilot", api: "openai-completions", id: "gpt-5.5" })).toBe(false);
  });
});

describe("sanitizeGeminiSchema", () => {
  it("collapses an anyOf whose branch is an object to that object branch", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
        { type: "string", description: "root task" },
      ],
      description: "task or text",
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.type).toBe("object");
    expect(result.anyOf).toBeUndefined();
    expect(result.oneOf).toBeUndefined();
    expect(result.properties).toEqual({ agent: { type: "string" } });
    // description carried over from the union node when the branch lacked one
    expect(result.description).toBe("task or text");
  });

  it("collapses a single-branch anyOf wrapping an object", () => {
    const schema = { anyOf: [{ type: "object", properties: { x: { type: "string" } } }] };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.type).toBe("object");
    expect(result.anyOf).toBeUndefined();
  });

  it("treats a nullable object union as nullable on the object branch", () => {
    const schema = { anyOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "null" }] };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.type).toBe("object");
    expect(result.nullable).toBe(true);
  });

  it("keeps scalar multi-type unions as anyOf", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(Array.isArray(result.anyOf)).toBe(true);
    expect((result.anyOf as unknown[]).length).toBe(3);
  });

  it("collapses a nullable scalar union to nullable on the single type", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "null" }] };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.type).toBe("string");
    expect(result.nullable).toBe(true);
    expect(result.anyOf).toBeUndefined();
  });

  it("converts const to enum", () => {
    const result = sanitizeGeminiSchema({ const: "created" }) as JsonObject;
    expect(result.enum).toEqual(["created"]);
    expect(result.type).toBe("string");
  });

  it("collapses an anyOf of string literals to a single enum", () => {
    const schema = {
      anyOf: [{ const: "created" }, { const: "modified" }, { const: "deleted" }],
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.enum).toEqual(["created", "modified", "deleted"]);
    expect(result.type).toBe("string");
    expect(result.anyOf).toBeUndefined();
  });

  it("drops non-portable JSON Schema keywords", () => {
    const schema = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      title: "Thing",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 10, pattern: "^x", default: "x", format: "uri" },
        tags: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        bag: { type: "object", patternProperties: { "^.*$": { type: "string" } } },
      },
      required: ["name"],
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.$schema).toBeUndefined();
    expect(result.additionalProperties).toBeUndefined();
    expect(result.title).toBeUndefined();
    const props = result.properties as JsonObject;
    const name = props.name as JsonObject;
    expect(name).toEqual({ type: "string" });
    const tags = props.tags as JsonObject;
    expect(tags.minItems).toBeUndefined();
    expect(tags.uniqueItems).toBeUndefined();
    expect(tags.items).toEqual({ type: "string" });
    const bag = props.bag as JsonObject;
    expect(bag.patternProperties).toBeUndefined();
    expect(result.required).toEqual(["name"]);
  });

  it("prunes required entries not present in properties", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(result.required).toEqual(["a"]);
  });

  it("recurses into array items", () => {
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] },
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    const items = result.items as JsonObject;
    expect(items.type).toBe("object");
    expect(items.anyOf).toBeUndefined();
  });

  it("infers a missing object type from properties", () => {
    const result = sanitizeGeminiSchema({ properties: { a: { type: "string" } } }) as JsonObject;
    expect(result.type).toBe("object");
  });

  it("infers a missing object type from required", () => {
    const result = sanitizeGeminiSchema({ properties: { a: { type: "string" } }, required: ["a"] }) as JsonObject;
    expect(result.type).toBe("object");
  });

  it("infers a missing array type from items", () => {
    const result = sanitizeGeminiSchema({ items: { type: "string" } }) as JsonObject;
    expect(result.type).toBe("array");
  });

  it("collapses a tuple-form items array to a single object schema", () => {
    const schema = {
      type: "array",
      items: [
        { type: "string" },
        { type: "object", properties: { a: { type: "string" } } },
      ],
    };
    const result = sanitizeGeminiSchema(schema) as JsonObject;
    expect(Array.isArray(result.items)).toBe(false);
    expect((result.items as JsonObject).type).toBe("object");
    expect((result.items as JsonObject).properties).toEqual({ a: { type: "string" } });
  });
});

describe("sanitizeCopilotGeminiPayload", () => {
  const payloadWithTool = () => ({
    model: "gemini-3.1-pro-preview",
    messages: [],
    tools: [
      functionTool("task_tool", {
        type: "object",
        properties: {
          task: { anyOf: [{ type: "object", properties: { agent: { type: "string" } } }, { type: "string" }] },
        },
      }),
    ],
  });

  it("is a no-op for non-Gemini models", () => {
    const payload = payloadWithTool();
    const result = sanitizeCopilotGeminiPayload(payload, {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-opus-4.8",
    });
    expect(result).toBe(payload);
  });

  it("is a no-op when there are no tools", () => {
    const payload = { model: "gemini-3.1-pro-preview", messages: [] };
    expect(sanitizeCopilotGeminiPayload(payload, geminiModel())).toBe(payload);
  });

  it("sanitizes tool parameter schemas for Gemini and does not mutate the input", () => {
    const payload = payloadWithTool();
    const result = sanitizeCopilotGeminiPayload(payload, geminiModel()) as typeof payload;
    expect(result).not.toBe(payload);
    // original untouched
    const originalTask = (payload.tools[0].function.parameters as JsonObject).properties as JsonObject;
    expect((originalTask.task as JsonObject).anyOf).toBeDefined();
    // sanitized collapses the union
    const sanitizedTask = (result.tools[0].function.parameters as JsonObject).properties as JsonObject;
    expect((sanitizedTask.task as JsonObject).type).toBe("object");
    expect((sanitizedTask.task as JsonObject).anyOf).toBeUndefined();
  });

  it("produces a Gemini-safe schema for the real workflow tool parameters", () => {
    const raw = WorkflowParametersSchema as unknown;
    // The real workflow schema contains anyOf-of-object (the failing construct).
    expect(hasUnionWithObjectBranch(raw)).toBe(true);
    const payload = { model: "gemini-3.1-pro-preview", messages: [], tools: [functionTool("workflow", raw)] };
    const result = sanitizeCopilotGeminiPayload(payload, geminiModel()) as { tools: Array<{ function: { parameters: unknown } }> };
    const sanitized = result.tools[0].function.parameters;
    // After sanitization, no union retains an object/array branch.
    expect(hasUnionWithObjectBranch(sanitized)).toBe(false);
  });

  it("documents dropped keywords without overlapping the kept set", () => {
    // The drop-list is documentation-only (the loop keeps KEPT_SCHEMA_KEYWORDS
    // and omits everything else); assert it stays coherent.
    expect(DROPPED_SCHEMA_KEYWORDS.has("additionalProperties")).toBe(true);
    expect(DROPPED_SCHEMA_KEYWORDS.has("$schema")).toBe(true);
    for (const kept of ["type", "description", "enum", "properties", "required", "items", "nullable"]) {
      expect(DROPPED_SCHEMA_KEYWORDS.has(kept)).toBe(false);
    }
  });
});
