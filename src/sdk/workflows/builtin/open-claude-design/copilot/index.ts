/**
 * open-claude-design / copilot
 *
 * Copilot replica of the Claude open-claude-design workflow. Orchestrates
 * the design skill ecosystem (impeccable, critique, shape, polish, audit,
 * etc.) into a deterministic 5-phase pipeline:
 *
 *   Phase 1: Design System Onboarding — extract tokens, build Design.md (HIL)
 *   Phase 2: Import — aggregate text/URL/file references
 *   Phase 3: Generation — produce first design version
 *   Phase 4: Refinement Loop — bounded iterate with critique + user feedback
 *   Phase 5: Export/Handoff — HTML export + Claude Code handoff bundle
 *
 * Copilot-specific concerns (see references/failure-modes.md):
 *
 *   • F5 — every `ctx.stage()` is a FRESH session. Every specialist receives
 *     its required context verbatim in its first prompt.
 *   • F1 — Copilot's last assistant turn is often empty when the agent ends
 *     on a tool call. Use `getAssistantText()` (concatenation of every
 *     top-level non-empty assistant turn, ignoring sub-agent
 *     `parentToolCallId` traffic) instead of `.at(-1).data.content`.
 *   • F9 — `s.save()` receives `SessionEvent[]` from `s.session.getMessages()`.
 *
 * Sub-agents are dispatched via `sessionOpts.agent` (the Copilot-native way
 * to bind a session to a single named sub-agent). Permissions default to
 * `approveAll` so headless stages run unattended.
 *
 * See claude/index.ts for the full topology diagram and design rationale.
 *
 * Run: atomic workflow -n open-claude-design -a copilot "design a dashboard"
 */

import { defineWorkflow } from "../../../index.ts";
import type { SessionEvent } from "@github/copilot-sdk";
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

/**
 * Concatenate every top-level assistant turn's non-empty content. The final
 * `assistant.message` of a Copilot turn is often empty when the agent ends
 * on a tool call (F1), and sub-agent traffic is signalled by `parentToolCallId`.
 */
function getAssistantText(messages: SessionEvent[]): string {
  return messages
    .filter(
      (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
        m.type === "assistant.message" && !m.data.parentToolCallId,
    )
    .map((m) => m.data.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
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
  .for("copilot")
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
          { agent: "codebase-locator" },
          async (s) => {
            await s.session.send({
              prompt: buildDesignLocatorPrompt({ root }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
          },
        ),
        ctx.stage(
          {
            name: "ds-analyzer",
            headless: true,
            description: "Analyze design tokens and patterns",
          },
          {},
          { agent: "codebase-analyzer" },
          async (s) => {
            await s.session.send({
              prompt: buildDesignAnalyzerPrompt({ root }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
          },
        ),
        ctx.stage(
          {
            name: "ds-patterns",
            headless: true,
            description: "Find existing design patterns",
          },
          {},
          { agent: "codebase-pattern-finder" },
          async (s) => {
            await s.session.send({
              prompt: buildDesignPatternPrompt({ root }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
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
        {},
        async (s) => {
          await s.session.send({
            prompt: buildDesignSystemBuilderPrompt({
              root,
              locatorOutput: locator.result,
              analyzerOutput: analyzer.result,
              patternsOutput: patterns.result,
              existingImpeccable: await readImpeccableMd(root),
            }),
          });
          s.save(await s.session.getMessages());
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
            { agent: "codebase-online-researcher" },
            async (s) => {
              await s.session.send({
                prompt: buildWebCapturePrompt({
                  url: reference,
                  screenshotDir: scratchDir,
                }),
              });
              const messages = await s.session.getMessages();
              s.save(messages);
              return getAssistantText(messages);
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
            { agent: "codebase-analyzer" },
            async (s) => {
              await s.session.send({
                prompt: buildFileParserPrompt({ filePath: reference }),
              });
              const messages = await s.session.getMessages();
              s.save(messages);
              return getAssistantText(messages);
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
      {},
      async (s) => {
        await s.session.send({
          prompt: buildGeneratorPrompt({
            prompt,
            outputType,
            designSystem,
            importContext,
            root,
            outputDir: designDir,
          }),
        });
        s.save(await s.session.getMessages());
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
        {},
        async (s) => {
          await s.session.send({
            prompt: buildRefineFeedbackPrompt({
              prompt,
              designDir,
              iteration,
              maxIterations: MAX_REFINEMENTS,
            }),
          });
          const messages = await s.session.getMessages();
          s.save(messages);
          return getAssistantText(messages);
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
          { agent: "reviewer" },
          async (s) => {
            await s.session.send({
              prompt: buildCritiquePrompt({
                designDir,
                designSystem,
                userFeedback: feedback.result,
              }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
          },
        ),
        ctx.stage(
          {
            name: `screenshot-${iteration}`,
            headless: true,
            description: `Visual validation (iteration ${iteration})`,
          },
          {},
          { agent: "codebase-analyzer" },
          async (s) => {
            await s.session.send({
              prompt: buildScreenshotValidationPrompt({
                designDir,
                scratchDir,
              }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
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
        {},
        async (s) => {
          await s.session.send({
            prompt: buildApplyChangesPrompt({
              prompt,
              designDir,
              designSystem,
              userFeedback: feedback.result,
              critiqueOutput: critiqueResult.result,
              screenshotOutput: screenshotResult.result,
              scanFindings,
              iteration,
            }),
          });
          s.save(await s.session.getMessages());
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
        {},
        async (s) => {
          await s.session.send({
            prompt: buildForcedFixPrompt({
              designDir,
              designSystem,
              scanFindings: findingsText,
            }),
          });
          s.save(await s.session.getMessages());
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
      {},
      async (s) => {
        await s.session.send({
          prompt: buildExportPrompt({
            prompt,
            designDir,
            finalDesignDir,
            designSystem,
            outputType,
          }),
        });
        s.save(await s.session.getMessages());
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
