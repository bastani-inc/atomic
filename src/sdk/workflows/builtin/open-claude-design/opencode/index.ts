/**
 * open-claude-design / opencode
 *
 * OpenCode replica of the Claude open-claude-design workflow. Orchestrates
 * the design skill ecosystem (impeccable, critique, shape, polish, audit,
 * etc.) into a deterministic 5-phase pipeline:
 *
 *   Phase 1: Design System Onboarding — extract tokens, build Design.md (HIL)
 *   Phase 2: Import — aggregate text/URL/file references
 *   Phase 3: Generation — produce first design version
 *   Phase 4: Refinement Loop — bounded iterate with critique + user feedback
 *   Phase 5: Export/Handoff — HTML export + Claude Code handoff bundle
 *
 * OpenCode-specific concerns (see references/failure-modes.md):
 *
 *   • F5 — every `ctx.stage()` is a FRESH session. Every specialist receives
 *     its required context verbatim in its first prompt.
 *   • F3 — `result.data!.parts` is a heterogenous array (text/tool/reasoning/
 *     file parts). Use `extractResponseText()` to filter to text parts only;
 *     concatenating raw `parts` produces `[object Object]` strings.
 *   • F6 — every prompt explicitly requires trailing prose so transcripts and
 *     `extractResponseText()` reads are never empty.
 *   • F9 — `s.save()` receives the unwrapped `{ info, parts }` payload from
 *     `result.data!`; passing the full `result` breaks downstream reads.
 *
 * Sub-agents are dispatched via the `agent` parameter on
 * `s.client.session.prompt()` (OpenCode's SDK-native way to route a turn
 * to a named sub-agent).
 *
 * See claude/index.ts for the full topology diagram and design rationale.
 *
 * Run: atomic workflow -n open-claude-design -a opencode "design a dashboard"
 */

import { defineWorkflow } from "../../../index.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { MAX_REFINEMENTS, DESIGNS_DIR } from "../helpers/constants.ts";
import {
  loadDesignSystem,
  persistDesignSystem,
  readImpeccableMd,
  slugifyPrompt,
  ensureScratchDir,
} from "../helpers/design-system.ts";
import {
  isUrl,
  isFilePath,
  aggregateImportResults,
} from "../helpers/import.ts";
import { isRefinementComplete } from "../helpers/validation.ts";
import { writeHandoffBundle } from "../helpers/export.ts";
import {
  hasBlockingFindings,
  renderScanFindings,
  runImpeccableScan,
} from "../helpers/scan.ts";
import {
  buildDesignLocatorPrompt,
  buildDesignAnalyzerPrompt,
  buildDesignPatternPrompt,
  buildDesignSystemBuilderPrompt,
  buildWebCapturePrompt,
  buildFileParserPrompt,
  buildGeneratorPrompt,
  buildRefineFeedbackPrompt,
  buildCritiquePrompt,
  buildScreenshotValidationPrompt,
  buildApplyChangesPrompt,
  buildForcedFixPrompt,
  buildExportPrompt,
} from "../helpers/prompts.ts";

/** Filter for text parts only — non-text parts produce [object Object]. */
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
}

export default defineWorkflow({
  name: "open-claude-design",
  source: import.meta.path,
  description:
    "AI-powered design workflow: design system onboarding → import → generate → refine → export/handoff",
  inputs: [
    {
      name: "prompt",
      type: "text",
      required: true,
      description:
        "What to design (e.g., 'a dashboard for monitoring API latency')",
    },
    {
      name: "reference",
      type: "text",
      required: false,
      description:
        "URL, file path, or codebase path to import as design reference",
    },
    {
      name: "output-type",
      type: "enum",
      required: false,
      values: ["prototype", "wireframe", "page", "component"],
      default: "prototype",
      description: "Type of design output to generate",
    },
    {
      name: "design-system",
      type: "text",
      required: false,
      description: "Path to existing Design.md (skips onboarding if provided)",
    },
  ],
})
  .for("opencode")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const reference = ctx.inputs.reference ?? "";
    const outputType = ctx.inputs["output-type"] ?? "prototype";
    const designSystemPath = ctx.inputs["design-system"] ?? "";

    const root = process.cwd();
    const slug = slugifyPrompt(prompt);
    const isoDate = new Date().toISOString().slice(0, 10);
    const scratchDir = await ensureScratchDir(root);
    const designDir = path.join(scratchDir, slug);
    await mkdir(designDir, { recursive: true });

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 1: Design System Onboarding
    // ══════════════════════════════════════════════════════════════════════

    let designSystem;

    if (designSystemPath.trim()) {
      // Skip onboarding — user provided an existing Design.md
      designSystem = await loadDesignSystem(designSystemPath);
    } else {
      // Layer 1: Parallel headless codebase analysis
      const [locator, analyzer, patterns] = await Promise.all([
        ctx.stage(
          {
            name: "ds-locator",
            headless: true,
            description: "Locate design files and tokens",
          },
          {},
          { title: "ds-locator" },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                { type: "text", text: buildDesignLocatorPrompt({ root }) },
              ],
              agent: "codebase-locator",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
        ctx.stage(
          {
            name: "ds-analyzer",
            headless: true,
            description: "Analyze design tokens and patterns",
          },
          {},
          { title: "ds-analyzer" },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                { type: "text", text: buildDesignAnalyzerPrompt({ root }) },
              ],
              agent: "codebase-analyzer",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
        ctx.stage(
          {
            name: "ds-patterns",
            headless: true,
            description: "Find existing design patterns",
          },
          {},
          { title: "ds-patterns" },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                { type: "text", text: buildDesignPatternPrompt({ root }) },
              ],
              agent: "codebase-pattern-finder",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
      ]);

      // Layer 2: Visible stage with HIL — presents findings, asks user to
      // approve/modify each design element category
      await ctx.stage(
        {
          name: "design-system-builder",
          description: "Build design system with user approval (HIL)",
        },
        {},
        { title: "design-system-builder" },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildDesignSystemBuilderPrompt({
                  root,
                  locatorOutput: locator.result,
                  analyzerOutput: analyzer.result,
                  patternsOutput: patterns.result,
                  existingImpeccable: await readImpeccableMd(root),
                }),
              },
            ],
          });
          s.save(result.data!);
        },
      );

      // Deterministic: read back the Design.md the agent wrote
      designSystem = await persistDesignSystem(root);
    }

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 2: Import
    // ══════════════════════════════════════════════════════════════════════

    const importResults = await Promise.all([
      // Web capture (only if reference is a URL)
      isUrl(reference)
        ? ctx.stage(
            {
              name: "web-capture",
              headless: true,
              description: "Capture web reference via playwright",
            },
            {},
            { title: "web-capture" },
            async (s) => {
              const result = await s.client.session.prompt({
                sessionID: s.session.id,
                parts: [
                  {
                    type: "text",
                    text: buildWebCapturePrompt({
                      url: reference,
                      screenshotDir: scratchDir,
                    }),
                  },
                ],
                agent: "codebase-online-researcher",
              });
              s.save(result.data!);
              return extractResponseText(result.data!.parts);
            },
          )
        : null,

      // File parser (only if reference is a file path)
      isFilePath(reference)
        ? ctx.stage(
            {
              name: "file-parser",
              headless: true,
              description: "Parse reference document",
            },
            {},
            { title: "file-parser" },
            async (s) => {
              const result = await s.client.session.prompt({
                sessionID: s.session.id,
                parts: [
                  {
                    type: "text",
                    text: buildFileParserPrompt({ filePath: reference }),
                  },
                ],
                agent: "codebase-analyzer",
              });
              s.save(result.data!);
              return extractResponseText(result.data!.parts);
            },
          )
        : null,
    ]);

    // Deterministic aggregation
    const importContext = aggregateImportResults({
      prompt,
      reference,
      webCapture: importResults[0]?.result ?? null,
      fileParse: importResults[1]?.result ?? null,
    });

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 3: Generation
    // ══════════════════════════════════════════════════════════════════════

    await ctx.stage(
      { name: "generator", description: "Generate first design version" },
      {},
      { title: "generator" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: buildGeneratorPrompt({
                prompt,
                outputType,
                designSystem,
                importContext,
                root,
                outputDir: designDir,
              }),
            },
          ],
        });
        s.save(result.data!);
      },
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 4: Refinement Loop
    // ══════════════════════════════════════════════════════════════════════

    for (let iteration = 1; iteration <= MAX_REFINEMENTS; iteration++) {
      // Step 1: Collect user feedback via HIL
      const feedback = await ctx.stage(
        {
          name: `user-feedback-${iteration}`,
          description: `Collect refinement feedback (iteration ${iteration})`,
        },
        {},
        { title: `user-feedback-${iteration}` },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildRefineFeedbackPrompt({
                  prompt,
                  designDir,
                  iteration,
                  maxIterations: MAX_REFINEMENTS,
                }),
              },
            ],
          });
          s.save(result.data!);
          return extractResponseText(result.data!.parts);
        },
      );

      // Check if user signaled "done" via HIL response
      if (isRefinementComplete(feedback.result)) break;

      // Step 2: Parallel validation — critique + screenshot
      const [critiqueResult, screenshotResult] = await Promise.all([
        ctx.stage(
          {
            name: `critique-${iteration}`,
            headless: true,
            description: `Design critique (iteration ${iteration})`,
          },
          {},
          { title: `critique-${iteration}` },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildCritiquePrompt({
                    designDir,
                    designSystem,
                    userFeedback: feedback.result,
                  }),
                },
              ],
              agent: "reviewer",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
        ctx.stage(
          {
            name: `screenshot-${iteration}`,
            headless: true,
            description: `Visual validation (iteration ${iteration})`,
          },
          {},
          { title: `screenshot-${iteration}` },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildScreenshotValidationPrompt({
                    designDir,
                    scratchDir,
                  }),
                },
              ],
              agent: "codebase-analyzer",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
      ]);

      // Step 3: Deterministic scan — surface banned anti-patterns so the
      // apply-changes stage can fix them alongside user feedback. No LLM
      // call; runs the `impeccable detect` CLI directly.
      const scan = await runImpeccableScan(designDir);
      const scanFindings =
        scan.available && scan.findings.length > 0
          ? renderScanFindings(scan.findings)
          : scan.available
            ? ""
            : `(scanner unavailable: ${scan.reason} — proceed without scan input)`;

      // Step 4: Apply changes based on feedback + critique + scanner findings
      await ctx.stage(
        {
          name: `apply-changes-${iteration}`,
          description: `Apply refinements (iteration ${iteration})`,
        },
        {},
        { title: `apply-changes-${iteration}` },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildApplyChangesPrompt({
                  prompt,
                  designDir,
                  designSystem,
                  userFeedback: feedback.result,
                  critiqueOutput: critiqueResult.result,
                  screenshotOutput: screenshotResult.result,
                  scanFindings,
                  iteration,
                }),
              },
            ],
          });
          s.save(result.data!);
        },
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // Hard enforcement gate — runs before export, independent of the
    // refinement loop's exit condition. Guarantees no design ships with
    // scanner findings even if the user approved early or MAX_REFINEMENTS
    // was reached with the agent still introducing banned patterns.
    // ══════════════════════════════════════════════════════════════════════

    const preExportScan = await runImpeccableScan(designDir);
    if (hasBlockingFindings(preExportScan)) {
      const findings = (
        preExportScan as Extract<typeof preExportScan, { available: true }>
      ).findings;
      const findingsText = renderScanFindings(findings);

      await ctx.stage(
        {
          name: "forced-fix",
          description: "Remove banned anti-patterns before export",
        },
        {},
        { title: "forced-fix" },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildForcedFixPrompt({
                  designDir,
                  designSystem,
                  scanFindings: findingsText,
                }),
              },
            ],
          });
          s.save(result.data!);
        },
      );

      const rescan = await runImpeccableScan(designDir);
      if (hasBlockingFindings(rescan)) {
        const remaining = (
          rescan as Extract<typeof rescan, { available: true }>
        ).findings;
        throw new Error(
          `open-claude-design: export blocked — ${remaining.length} ` +
            `banned anti-pattern(s) remain after forced fix:\n` +
            renderScanFindings(remaining),
        );
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 5: Export / Handoff
    // ══════════════════════════════════════════════════════════════════════

    const finalDesignDir = path.join(root, DESIGNS_DIR, `${isoDate}-${slug}`);

    await ctx.stage(
      {
        name: "exporter",
        description: "Export design and create handoff bundle",
      },
      {},
      { title: "exporter" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: buildExportPrompt({
                prompt,
                designDir,
                finalDesignDir,
                designSystem,
                outputType,
              }),
            },
          ],
        });
        s.save(result.data!);
      },
    );

    // Deterministic: package handoff bundle (copies Design.md, writes
    // handoff-prompt.md and README.md — no LLM call)
    await writeHandoffBundle(finalDesignDir, {
      designSystem,
      prompt,
      outputType,
    });
  })
  .compile();
