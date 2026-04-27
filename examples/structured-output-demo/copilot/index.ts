/**
 * Structured-output demo for Copilot.
 *
 * Copilot SDK doesn't expose a `json_schema`-style response format — its
 * native path for schema-enforced output is a custom tool built with
 * `defineTool`. The Copilot SDK validates the tool-call arguments
 * against the Zod schema before the handler fires, so by the time
 * `handler(data)` runs, `data` is already a typed, validated object.
 *
 * Run: bun run examples/structured-output-demo/copilot-worker.ts --prompt=Python
 */

import { defineWorkflow } from "@bastani/atomic/workflows";
import { defineTool } from "@github/copilot-sdk";

import {
  LanguageFactsSchema,
  buildPrompt,
  logFacts,
  type LanguageFacts,
} from "../helpers/schema.ts";

const SUBMIT_TOOL_DESCRIPTION =
  "Submit the structured language facts. You MUST call this tool exactly " +
  "once with your complete answer. Do not output the facts as plain text.";

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
  .for("copilot")
  .run(async (ctx) => {
    const topic = ctx.inputs.prompt ?? "Python";

    let captured: LanguageFacts | null = null;
    const submitFacts = defineTool("submit_facts", {
      description: SUBMIT_TOOL_DESCRIPTION,
      parameters: LanguageFactsSchema,
      skipPermission: true,
      handler: async (data: LanguageFacts) => {
        captured = data;
        return "Facts submitted.";
      },
    });

    await ctx.stage(
      { name: "describe" },
      {},
      { tools: [submitFacts] },
      async (s) => {
        await s.session.send({
          prompt:
            buildPrompt(topic) +
            "\n\nCall the `submit_facts` tool with your answer.",
        });
        s.save(await s.session.getMessages());

        logFacts("copilot", captured);
        if (!captured) {
          throw new Error(
            "Copilot did not call submit_facts — structured output unavailable",
          );
        }
      },
    );
  })
  .compile();
