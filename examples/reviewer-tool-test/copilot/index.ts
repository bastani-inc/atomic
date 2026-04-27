/**
 * Dummy workflow to verify that a reviewer subagent can invoke a
 * workflow-registered `submit_review` custom tool.
 *
 * Background: Copilot CLI treats a subagent's `tools:` frontmatter as a
 * restrictive allowlist validated against its built-in tool-alias
 * registry at parse time — custom SDK-registered tools are unknown then
 * and get silently dropped. Defining the reviewer inline via
 * `customAgents` at session creation runs the tool allowlist against the
 * live tool registry, which DOES know about `submit_review`. This
 * workflow proves that mechanic end-to-end.
 *
 * Pass criterion: the `submit_review` handler fires exactly once with a
 * `{ verdict, explanation }` object. If it doesn't, the workflow throws.
 *
 * Run: bun run examples/reviewer-tool-test/copilot-worker.ts
 */

import { defineWorkflow } from "@bastani/atomic/workflows";
import { defineTool } from "@github/copilot-sdk";
import type { CustomAgentConfig } from "@github/copilot-sdk";
import { z } from "zod";

const SubmitReviewSchema = z.object({
  verdict: z
    .enum(["patch is correct", "patch is incorrect"])
    .describe("Exact literal verdict — no paraphrase."),
  explanation: z.string().describe("One-sentence justification."),
});

type SubmitReviewArgs = z.infer<typeof SubmitReviewSchema>;

const DUMMY_PATCH = `diff --git a/hello.ts b/hello.ts
index 0000001..0000002 100644
--- a/hello.ts
+++ b/hello.ts
@@ -1 +1 @@
-export const greeting = "hi";
+export const greeting = "hello";
`;

const REVIEW_PROMPT = `You are reviewing the following one-line patch.

<patch>
${DUMMY_PATCH}
</patch>

Call the \`submit_review\` tool exactly once with your verdict. Do NOT
output the review as plain text — the tool enforces the required schema.`;

export default defineWorkflow({
  name: "reviewer-tool-test",
  source: import.meta.path,
  description:
    "Verify the reviewer subagent can call a workflow-registered submit_review tool",
  inputs: [],
})
  .for("copilot")
  .run(async (ctx) => {
    let captured: SubmitReviewArgs | null = null;

    const submitReview = defineTool("submit_review", {
      description:
        "Submit the structured review verdict. Call this tool exactly once.",
      parameters: SubmitReviewSchema,
      skipPermission: true,
      handler: async (data: SubmitReviewArgs) => {
        captured = data;
        return "Review submitted.";
      },
    });

    const inlineReviewer: CustomAgentConfig = {
      name: "reviewer",
      displayName: "reviewer",
      description: "Test reviewer subagent wired to submit_review.",
      tools: ["execute", "read", "search", "submit_review"],
      prompt:
        "You are a code reviewer. Use the `submit_review` tool to return your verdict. Do not output the review as plain text.",
    };

    await ctx.stage(
      { name: "review" },
      {},
      {
        agent: "reviewer",
        tools: [submitReview],
        customAgents: [inlineReviewer],
      },
      async (s) => {
        await s.session.send({ prompt: REVIEW_PROMPT });
        s.save(await s.session.getMessages());

        if (!captured) {
          console.log("[reviewer-tool-test] submit_review was NOT called");
          throw new Error(
            "reviewer subagent did not call submit_review — tool allowlist likely filtered it out",
          );
        }

        console.log(
          `[reviewer-tool-test] submit_review fired:\n${JSON.stringify(captured, null, 2)}`,
        );
      },
    );
  })
  .compile();
