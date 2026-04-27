/**
 * Structured-output demo for OpenCode.
 *
 * Runs a single stage that asks for structured facts about a programming
 * language and enforces the schema via `format: { type: "json_schema" }`.
 * The validated object is read from the AssistantMessage's `structured`
 * field (see `@opencode-ai/sdk` v2 types — AssistantMessage.structured).
 *
 * Run: bun run examples/structured-output-demo/opencode-worker.ts --prompt=Python
 */

import { defineWorkflow } from "@bastani/atomic/workflows";

import {
  LanguageFactsSchema,
  LANGUAGE_FACTS_JSON_SCHEMA,
  buildPrompt,
  logFacts,
  type LanguageFacts,
} from "../helpers/schema.ts";

export default defineWorkflow({
  name: "structured-output-demo",
  source: import.meta.path,
  description:
    "Ask for structured facts about a language and prove each SDK's native structured-output path works",
  inputs: [
    {
      name: "prompt",
      type: "string",
      required: true,
      description: "programming language to describe",
      default: "Python",
    },
  ],
})
  .for("opencode")
  .run(async (ctx) => {
    const topic = ctx.inputs.prompt ?? "Python";

    await ctx.stage(
      { name: "describe" },
      {},
      { title: "describe" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: buildPrompt(topic) }],
          format: {
            type: "json_schema" as const,
            schema: LANGUAGE_FACTS_JSON_SCHEMA,
          },
        });
        s.save(result.data!);

        const structured = (result.data!.info as { structured?: unknown })
          ?.structured;
        const parsed = LanguageFactsSchema.safeParse(structured);
        const facts: LanguageFacts | null = parsed.success
          ? parsed.data
          : null;

        logFacts("opencode", facts);
        if (!facts) {
          console.log(
            `[opencode] validation failed — raw structured value: ${JSON.stringify(structured)}`,
          );
          throw new Error(
            "OpenCode structured output was missing or failed schema validation",
          );
        }
      },
    );
  })
  .compile();
