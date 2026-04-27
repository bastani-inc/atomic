/**
 * Review/fix loop — the quintessential harness pattern.
 *
 * Produce a draft, then loop: review → (if verdict is `needs_fix`) fix.
 * Bounded by `max_iterations`, with early exit when the review comes back
 * `clean`. The review stage returns a structured verdict from its callback,
 * which becomes `handle.result` on the returned `SessionHandle` — that's how
 * the surrounding TypeScript reads the LLM's answer and decides whether to
 * keep looping.
 *
 * Note the handoff pattern: `lastHandle` tracks whichever stage produced the
 * currently-valid draft (either the seed or the most recent fix). Each review
 * reads `s.transcript(lastHandle)` to see the latest draft; each fix reads
 * the latest draft AND the review feedback to make a revision. This keeps
 * the loop's information flow explicit.
 */

import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

export default defineWorkflow({
  name: "review-fix-loop",
  source: import.meta.path,
  description: "Generate → review → fix loop with bounded iterations and early exit on clean review",
  inputs: [
    {
      name: "topic",
      type: "string",
      required: true,
      default: "adopting Bun at a small engineering team",
      description: "what the draft should argue",
    },
    {
      name: "max_iterations",
      type: "integer",
      default: 3,
      description: "maximum number of review/fix rounds before giving up",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    const topic = ctx.inputs.topic ?? "adopting Bun at a small engineering team";
    const maxIterations = ctx.inputs.max_iterations ?? 3;

    // Seed draft.
    const draft = await ctx.stage(
      { name: "draft", description: "Produce the initial two-paragraph draft" },
      {},
      {},
      async (s) => {
        await s.session.query(
          `Write a two-paragraph argument for ${topic}. Be concrete — cite at least two specific benefits. Write it as prose, not a list.`,
        );
        s.save(s.sessionId);
      },
    );

    // `lastHandle` is whichever stage produced the current draft. The review
    // stage reads from it; the fix stage (if any) replaces it for the next
    // round.
    let lastHandle = draft;

    for (let i = 1; i <= maxIterations; i++) {
      const review = await ctx.stage(
        { name: `review-${i}`, description: "Judge the latest draft" },
        {},
        {},
        async (s) => {
          const prior = await s.transcript(lastHandle);
          const messages = await s.session.query(
            `Read the draft in ${prior.path}. On a single line, reply with either "CLEAN" if the draft is ready to ship, or "NEEDS_FIX: <one-sentence description of the single biggest issue>".`,
          );
          s.save(s.sessionId);

          const verdict = extractAssistantText(messages, 0).toUpperCase();
          return verdict.includes("CLEAN") && !verdict.includes("NEEDS_FIX")
            ? ("clean" as const)
            : ("needs_fix" as const);
        },
      );

      if (review.result === "clean") break;

      // Only fix if we're not on the last iteration — fixing on the last
      // iteration wastes a round because we'd never review the result.
      if (i === maxIterations) break;

      const fix = await ctx.stage(
        { name: `fix-${i}`, description: "Address the review's top issue" },
        {},
        {},
        async (s) => {
          const priorDraft = await s.transcript(lastHandle);
          const reviewFeedback = await s.transcript(review);
          await s.session.query(
            `Read the previous draft in ${priorDraft.path} and the review feedback in ${reviewFeedback.path}. Produce a revised two-paragraph draft that addresses the top issue. Preserve what worked; change only what the review flagged.`,
          );
          s.save(s.sessionId);
        },
      );

      lastHandle = fix;
    }
  })
  .compile();
