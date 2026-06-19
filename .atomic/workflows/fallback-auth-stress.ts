/**
 * fallback-auth-stress — a throwaway repro/regression harness for issue #1431.
 *
 * Issue #1431: a workflow stage that is forced through model fallback could
 * misreport configured providers as `No API key found` when many stages create
 * sessions concurrently (each fresh AuthStorage re-reads auth.json under a file
 * lock; under contention that read fails and silently yields an empty
 * credential set).
 *
 * This workflow reproduces the trigger conditions on purpose:
 *   - every stage's PRIMARY model is intentionally UNAVAILABLE (so it returns a
 *     real provider 404 — proving auth exists — and forces fallback), and
 *   - it runs many such stages in parallel (so multiple sessions create/read
 *     auth credentials at the same time), optionally across several waves.
 *
 * It then inspects each stage's `modelAttempts` (and any hard-failure errors)
 * for the tell-tale "No API key found" / "could not load stored credentials"
 * text against a CONFIGURED provider, and prints a PASS/FAIL verdict.
 *
 *   PASS  → every stage fell back cleanly; no configured provider was
 *           misreported as missing/unreadable credentials (the fixed build).
 *   FAIL  → at least one configured provider was reported missing while a
 *           sibling/later attempt could use it (the issue #1431 symptom).
 *
 * Run it yourself (defaults mirror the issue's provider set):
 *
 *   /workflow run fallback-auth-stress
 *   /workflow run fallback-auth-stress reviewers=12 loops=3
 *   /workflow run fallback-auth-stress \
 *     primary_model="github-copilot/claude-fable-5" \
 *     fallback_models="anthropic/claude-opus-4-8,openai-codex/gpt-5.5"
 *
 * IMPORTANT: set `primary_model` to a NON-EXISTENT model on a provider you ARE
 * authenticated with, and set `fallback_models` to real models on providers you
 * ARE authenticated with. The point is to force fallback while proving the auth
 * actually exists.
 */
import { defineWorkflow, Type } from "@bastani/workflows";

const DEFAULT_PRIMARY = "anthropic/claude-fable-5";
const DEFAULT_FALLBACKS = "github-copilot/claude-opus-4.8,anthropic/claude-opus-4-8,openai-codex/gpt-5.5";

/** Text the bug produces for a configured-but-"missing" provider. */
const MISSING_KEY_RE = /no api key found|could not load stored credentials/i;

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function firstLine(text: string, max = 200): string {
  return (text.split("\n")[0] ?? "").slice(0, max);
}

export default defineWorkflow("fallback-auth-stress")
  .description(
    "Repro/regression harness for issue #1431: forces many parallel stages through model fallback (unavailable primary -> configured fallbacks) to detect 'No API key found' misreports for configured providers under concurrent auth access.",
  )
  .input(
    "primary_model",
    Type.String({
      default: DEFAULT_PRIMARY,
      description:
        "An UNAVAILABLE model on a provider you ARE authenticated with (forces fallback while proving auth exists), e.g. anthropic/claude-fable-5.",
    }),
  )
  .input(
    "fallback_models",
    Type.String({
      default: DEFAULT_FALLBACKS,
      description: "Comma-separated fallback models on providers you ARE authenticated with.",
    }),
  )
  .input(
    "reviewers",
    Type.Number({
      default: 6,
      description: "Parallel stages per wave. Higher values increase concurrent auth.json contention.",
    }),
  )
  .input(
    "loops",
    Type.Number({
      default: 1,
      description: "Number of sequential parallel waves. More waves widen the contention window.",
    }),
  )
  .output("result", Type.String({ description: "One-line PASS/FAIL verdict." }))
  .output("ok", Type.Boolean({ description: "True when no configured provider was misreported as missing its API key." }))
  .output(
    "misreports",
    Type.Number({ description: "Count of fallback attempts/failures that wrongly reported a configured provider's key as missing/unreadable." }),
  )
  .output("report", Type.String({ description: "Detailed per-stage model-attempt report." }))
  .run(async (ctx) => {
    const primaryModel = (String(ctx.inputs.primary_model ?? DEFAULT_PRIMARY).trim() || DEFAULT_PRIMARY);
    const fallbackModels = parseList(String(ctx.inputs.fallback_models ?? DEFAULT_FALLBACKS));
    const reviewers = Math.max(1, Math.floor(Number(ctx.inputs.reviewers ?? 6)));
    const loops = Math.max(1, Math.floor(Number(ctx.inputs.loops ?? 1)));

    const lines: string[] = [];
    let misreports = 0;
    let hardFailures = 0;

    lines.push("# fallback-auth-stress (issue #1431)");
    lines.push(`primary (intentionally unavailable): ${primaryModel}`);
    lines.push(`fallbacks (must be configured): ${fallbackModels.join(", ") || "(none)"}`);
    lines.push(`reviewers/wave: ${reviewers}   loops: ${loops}`);
    lines.push("");

    for (let loop = 0; loop < loops; loop++) {
      const items = Array.from({ length: reviewers }, (_unused, i) => {
        const tag = `L${loop + 1}R${i + 1}`;
        return {
          name: `reviewer-${tag}`,
          // Trivial, tool-free prompt: keep each stage cheap; we only care about
          // which model answers and what the fallback attempt chain looks like.
          prompt: `You are stress-test stage ${tag}. Reply with exactly this text and nothing else: OK-${tag}`,
          model: primaryModel,
          fallbackModels,
          context: "fresh" as const,
        };
      });

      lines.push(`## Wave ${loop + 1}`);
      try {
        // failFast: false so one stage's exhausted-fallback failure does not
        // cancel its siblings — we want the full picture of the whole wave.
        const results = await ctx.parallel(items, { concurrency: reviewers, failFast: false });
        results.forEach((res, i) => {
          const tag = `L${loop + 1}R${i + 1}`;
          const answeredBy = res.model ?? "(unknown)";
          const attempts = res.modelAttempts ?? [];
          const misreportAttempts = attempts.filter(
            (attempt) => !attempt.success && attempt.error !== undefined && MISSING_KEY_RE.test(attempt.error),
          );
          misreports += misreportAttempts.length;

          const chain =
            attempts
              .map((attempt) => `${attempt.model}${attempt.success ? " ✓" : ` ✗(${firstLine(attempt.error ?? "", 90)})`}`)
              .join("  ->  ") || "(no attempts recorded)";

          lines.push(`- ${tag}: answered by ${answeredBy}`);
          lines.push(`    chain: ${chain}`);
          if (misreportAttempts.length > 0) {
            lines.push(
              `    ⚠ MISREPORT: ${misreportAttempts.length} configured provider(s) wrongly reported missing/unreadable credentials -> ${misreportAttempts
                .map((attempt) => attempt.model)
                .join(", ")}`,
            );
          }
        });
      } catch (error) {
        // ctx.parallel throws an AggregateError when one or more stages fail
        // (e.g. a stage exhausted its fallback chain reporting missing keys).
        hardFailures += 1;
        const aggregate = error as { errors?: readonly unknown[]; message?: string };
        const messages =
          Array.isArray(aggregate.errors) && aggregate.errors.length > 0
            ? aggregate.errors.map((entry) => (entry instanceof Error ? entry.message : String(entry)))
            : [aggregate.message ?? String(error)];
        const misreportMessages = messages.filter((message) => MISSING_KEY_RE.test(message));
        misreports += misreportMessages.length;

        lines.push(`- WAVE ${loop + 1}: ${messages.length} stage(s) hard-failed`);
        for (const message of messages) {
          const flagged = MISSING_KEY_RE.test(message) ? " ⚠ MISSING-KEY MISREPORT" : "";
          lines.push(`    ✗ ${firstLine(message)}${flagged}`);
        }
      }
      lines.push("");
    }

    const ok = misreports === 0 && hardFailures === 0;
    const verdict = ok
      ? "PASS — every stage fell back cleanly; no configured provider was misreported as missing/unreadable (issue #1431 not reproduced)."
      : `FAIL — ${misreports} missing-key misreport(s)` +
        (hardFailures > 0 ? ` across ${hardFailures} hard-failed wave(s)` : "") +
        " — this is the issue #1431 symptom.";

    const report = [`VERDICT: ${verdict}`, "", ...lines].join("\n");
    return { result: verdict, ok, misreports, report };
  })
  .compile();
