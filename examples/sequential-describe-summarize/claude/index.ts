/**
 * Sequential two-stage workflow — the canonical `s.save()` / `s.transcript()`
 * handoff pattern.
 *
 * Stage 1 ("describe") writes a detailed paragraph, persists it via `s.save()`,
 * and returns a `SessionHandle`. Stage 2 ("summarize") reads that handle's
 * transcript from disk via `s.transcript(handle)` and produces a condensed
 * summary. This is the bread-and-butter handoff between stages in Atomic.
 */

import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
  name: "sequential-describe-summarize",
  source: import.meta.path,
  description: "Describe a topic, then summarize the description",
  inputs: [
    {
      name: "topic",
      type: "string",
      required: true,
      default: "TypeScript",
      description: "what to describe",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    const topic = ctx.inputs.topic ?? "TypeScript";

    // Stage 1: produce a detailed description. `s.save(s.sessionId)` tells
    // the runtime to read the Claude session's full transcript and write it
    // to disk so downstream stages can read it by handle.
    const describe = await ctx.stage(
      { name: "describe", description: "Produce a detailed paragraph about the topic" },
      {},
      {},
      async (s) => {
        await s.session.query(
          `Write one detailed paragraph (4–6 sentences) explaining ${topic} to an engineering audience. Focus on what problem it solves and why someone would reach for it.`,
        );
        s.save(s.sessionId);
      },
    );

    // Stage 2: read stage 1's transcript file off disk and compress it.
    // `s.transcript(handle)` returns `{ path, content }`; passing `path`
    // into the prompt lets Claude open the file directly via its Read tool
    // rather than dumping the whole content into the prompt.
    await ctx.stage(
      { name: "summarize", description: "Compress the description into two bullets" },
      {},
      {},
      async (s) => {
        const prior = await s.transcript(describe);
        await s.session.query(
          `Read the description in ${prior.path} and condense it into exactly two bullet points — the problem it solves, and when to choose it.`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
