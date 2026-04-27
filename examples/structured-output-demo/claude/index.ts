/**
 * Structured-output demo for Claude.
 *
 * Runs a single headless stage that asks for structured facts about a
 * programming language and enforces the schema via the Claude Agent SDK's
 * `outputFormat`. The validated object is read from
 * `s.session.lastStructuredOutput` — no text parsing.
 *
 * Run: bun run examples/structured-output-demo/claude-worker.ts --prompt=Python
 */

import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

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
  .for("claude")
  .run(async (ctx) => {
    const topic = ctx.inputs.prompt ?? "Python";

    await ctx.stage(
      { name: "describe", headless: true },
      {},
      {},
      async (s) => {
        const result = await s.session.query(buildPrompt(topic), {
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          outputFormat: {
            type: "json_schema",
            schema: LANGUAGE_FACTS_JSON_SCHEMA,
          },
        });
        s.save(s.sessionId);

        // safeParse catches drift between the JSON Schema the SDK
        // validated against and the Zod shape the workflow consumes —
        // if the two fall out of sync we want a loud failure, not a
        // silent mis-typed object.
        const parsed = LanguageFactsSchema.safeParse(
          s.session.lastStructuredOutput,
        );
        const facts: LanguageFacts | null = parsed.success
          ? parsed.data
          : null;

        logFacts("claude", facts);
        if (!facts) {
          const raw = extractAssistantText(result, 0);
          console.log(
            `[claude] validation failed — raw assistant text:\n${raw}`,
          );
          throw new Error(
            "Claude structured output was missing or failed schema validation",
          );
        }
      },
    );
  })
  .compile();
