/**
 * Prompt builders for the deep-research-codebase workflow.
 *
 * Each builder produces a focused, single-responsibility prompt for one
 * specialist sub-agent. The sub-agents themselves are dispatched as separate
 * `ctx.stage(...)` calls via the provider SDK's native `agent` parameter
 * (Claude SDK options, Copilot sessionOpts, OpenCode session.prompt). Because
 * each sub-agent already carries a detailed system prompt in `.claude/agents/`,
 * `.opencode/agents/`, and `.github/agents/`, these user-prompts are intentionally
 * short — they only supply the topic, the scope, and the output shape the
 * downstream synthesizer expects.
 *
 * Context-engineering principles applied throughout:
 *
 *   • Position-aware framing: the research question is repeated at the TOP
 *     and BOTTOM of every prompt. Long-context recall is strongest at the
 *     edges of the context window (see `context-fundamentals`).
 *
 *   • Informativity over exhaustiveness: each per-partition prompt embeds
 *     ONLY that partition's directories — never the full file list. This
 *     keeps token cost roughly constant in N rather than O(N²).
 *
 *   • Forward-only data flow: the analyzer prompt embeds the locator's
 *     output verbatim; the online-researcher prompt does the same. No
 *     sub-agent has to re-discover what its sibling already produced.
 *
 *   • Trailing-prose guarantee (failure-modes F6): every prompt asks for a
 *     short prose recap as the final assistant turn so downstream stages
 *     reading via `transcript()` never get an empty string when the agent
 *     ends on a tool call.
 *
 *   • Documentarian framing: every prompt explicitly forbids critique or
 *     improvement suggestions. We are recording what EXISTS.
 *
 *   • File-based handoff (filesystem-context skill): explorer findings are
 *     written deterministically to a scratch file by TypeScript (no extra
 *     LLM "synthesizer" stage) and the aggregator reads them by path.
 */

import type { PartitionUnit } from "./scout.ts";

const DOCUMENTARIAN_DISCLAIMER =
  "You are a documentarian, not a critic. Document what EXISTS — do not " +
  "propose improvements, identify issues, or suggest refactors. Focus on " +
  "concrete file paths, line numbers, and how things actually work.";

const TRAILING_PROSE_REMINDER =
  "End your turn with a short prose paragraph summarising what you produced. " +
  "Do NOT end the turn on a tool call — downstream stages read your assistant " +
  "transcript and will see nothing if the final message is a tool invocation.";

/** Trim `text`; return `fallback` when the trimmed result is empty. */
function trimOr(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Slugify the user's prompt for use in the final research filename. */
export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .substring(0, 60);
  return slug || "research";
}

/** Render a partition's directory list as repo-relative paths with file/LOC counts. */
function renderPartitionAssignment(partition: PartitionUnit[]): string {
  return partition
    .map(
      (u) =>
        `  - \`${u.path}/\` (${u.fileCount} files, ${u.loc.toLocaleString()} LOC)`,
    )
    .join("\n");
}

/** Comma-separated repo-relative directory list (for inline grep/glob scope hints). */
function renderPartitionDirs(partition: PartitionUnit[]): string {
  return partition.map((u) => `\`${u.path}/\``).join(", ");
}

/**
 * Render the `<ARCHITECTURAL_ORIENTATION>` block shared by the locator,
 * pattern-finder, and analyzer specialist prompts. Each specialist embeds the
 * same scout briefing and points to its partition's seed section.
 */
function renderArchitecturalOrientation(
  partitionIndex: number,
  orientation: string,
): string[] {
  return [
    `<ARCHITECTURAL_ORIENTATION>`,
    `The briefing below contains both a high-level orientation AND per-partition`,
    `ast-grep query seeds. Find the **Partition ${partitionIndex}** section for the`,
    `seeds scoped to your investigation — treat them as starting points, not`,
    `commands. Adapt or skip seeds that don't fit what you actually find.`,
    ``,
    orientation,
    `</ARCHITECTURAL_ORIENTATION>`,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1a — codebase-scout + query planner (single LLM call)
// ─────────────────────────────────────────────────────────────────────────────
//
// The scout produces both a ≤300-word architectural orientation AND a list of
// per-partition ast-grep query seeds. The combined output is embedded verbatim
// into each specialist sub-agent's prompt as a single <ARCHITECTURAL_ORIENTATION>
// block — no JSON envelope, no deterministic parser. Specialists locate "their"
// partition's seeds by searching for the matching section header inside the
// block and treat them as starting points, not commands.

export function buildScoutPrompt(opts: {
  question: string;
  tree: string;
  totalLoc: number;
  totalFiles: number;
  explorerCount: number;
  partitionPreview: PartitionUnit[][];
}): string {
  const partitionPreview = opts.partitionPreview
    .map((bin, i) => {
      const loc = bin.reduce((s, u) => s + u.loc, 0);
      return `  ${i + 1}. ${renderPartitionDirs(bin)} — ${loc.toLocaleString()} LOC`;
    })
    .join("\n");

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<CONTEXT>`,
    `You are the codebase scout AND query planner for the deep-research-codebase`,
    `workflow. The workflow has already computed the codebase layout`,
    `deterministically:`,
    ``,
    `- Total source files: ${opts.totalFiles.toLocaleString()}`,
    `- Total LOC: ${opts.totalLoc.toLocaleString()}`,
    `- Partitions to investigate: ${opts.explorerCount} (chosen by LOC heuristic)`,
    ``,
    `Pre-computed partition assignments (${opts.explorerCount} partitions):`,
    partitionPreview,
    ``,
    `Compact directory tree (depth 3, ≤200 entries):`,
    "```",
    opts.tree,
    "```",
    `</CONTEXT>`,
    ``,
    `<TOOLING>`,
    `Default to ast-grep over plain grep when investigating code structure (decorators,`,
    `async/await pairings, kind+has rules). Invoke via Bash: \`ast-grep --lang <lang> -p '<pat>'\``,
    `or a fenced YAML rule block — scout has no MCP tools; the specialist sub-agents do.`,
    ``,
    `Consult https://ast-grep.github.io/reference/languages.html for the canonical`,
    `language list, and https://ast-grep.github.io/llms-full.txt for the full rule`,
    `reference, when you need them.`,
    `</TOOLING>`,
    ``,
    `<TASK>`,
    `Produce TWO sections — both will be embedded verbatim into the specialist`,
    `sub-agents' prompts. Use the markdown headers shown so specialists can`,
    `find their partition's seeds.`,
    ``,
    `## Orientation`,
    `In ≤300 words, cover:`,
    `  1. The repo's overall shape (monorepo vs single package, polyglot or not)`,
    `  2. The 3-5 most important top-level directories and what each contains`,
    `  3. Architectural boundaries / layering visible from the tree`,
    `  4. Where entry points or main modules likely live`,
    ``,
    `## Query Seeds`,
    `For each of the ${opts.explorerCount} partitions, suggest 2-4 ast-grep`,
    `query seeds the specialists could start from. Format each seed as:`,
    ``,
    `### Partition <n>`,
    `- Query: \`ast-grep --lang <language> -p '<pattern>'\``,
    `  Why: <one sentence>`,
    ``,
    `For structural rules (kind + has/inside), use a fenced YAML block instead`,
    `of the \`-p\` form, with the same Why line.`,
    ``,
    `Seeds are starting points, not commands — specialists adapt as they find`,
    `things. If a partition is clearly irrelevant to the question, write a`,
    `single-line note explaining why and skip its seeds.`,
    `</TASK>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Do NOT investigate the codebase to answer the question yourself — your`,
    `job is orientation + seeding, not investigation. You may use Read/Glob/`,
    `Grep/ast-grep sparingly to verify guesses about a few key files or to`,
    `confirm a pattern parses, but keep output focused.`,
    `Stay under 300 words for the Orientation section. Plain markdown only —`,
    `no JSON envelope, no structured output.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — per-partition specialist sub-agents
// ─────────────────────────────────────────────────────────────────────────────
//
// Four specialists run per partition, dispatched as separate headless stages
// via the provider SDK's native `agent` parameter. Two layers of parallelism:
//
//   Layer 1 (independent searches):   locator   ∥  pattern-finder
//   Layer 2 (depend on locator):      analyzer  ∥  online-researcher
//
// The deterministic synthesis step (helpers/scratch.ts) then concatenates
// the four outputs into the explorer scratch file the aggregator will read.

/** codebase-locator — find files in the partition relevant to the question. */
export function buildLocatorPrompt(opts: {
  question: string;
  partition: PartitionUnit[];
  scoutOverview: string;
  index: number;
  total: number;
}): string {
  const assignment = renderPartitionAssignment(opts.partition);
  const dirs = renderPartitionDirs(opts.partition);
  const orientation = trimOr(
    opts.scoutOverview,
    "(scout overview unavailable — proceed without)",
  );

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-locator for partition ${opts.index} of ${opts.total} in a`,
    `deep-research workflow. Find every file inside the SCOPE below that`,
    `relates to the research question, and return a categorized index.`,
    `</MISSION>`,
    ``,
    ...renderArchitecturalOrientation(opts.index, orientation),
    ``,
    `<SCOPE>`,
    `Search ONLY within these directories. Other partitions cover the rest of`,
    `the codebase — do NOT wander outside your scope:`,
    ``,
    assignment,
    ``,
    `(Quick comma-separated form for tool args: ${dirs})`,
    `</SCOPE>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `Return a markdown report with this exact structure:`,
    ``,
    `### Implementation`,
    `- \`<repo-relative path>\` — 1-line note on relevance`,
    ``,
    `### Tests`,
    `- ...`,
    ``,
    `### Types / Interfaces`,
    `- ...`,
    ``,
    `### Configuration`,
    `- ...`,
    ``,
    `### Examples / Fixtures`,
    `- ...`,
    ``,
    `### Documentation`,
    `- ...`,
    ``,
    `### Notable Clusters`,
    `- \`<repo-relative dir>/\` — N files, why it's a cluster`,
    ``,
    `Omit any section that has no entries (do not write "(none)" placeholders).`,
    `Use repo-relative paths. Do NOT read file contents — your job is location only.`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Restrict every grep/glob to the SCOPE above.`,
    `Do not analyse implementations — siblings (analyzer, pattern-finder) cover that.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

/** codebase-pattern-finder — surface concrete reusable code patterns. */
export function buildPatternFinderPrompt(opts: {
  question: string;
  partition: PartitionUnit[];
  scoutOverview: string;
  index: number;
  total: number;
}): string {
  const assignment = renderPartitionAssignment(opts.partition);
  const dirs = renderPartitionDirs(opts.partition);
  const orientation = trimOr(
    opts.scoutOverview,
    "(scout overview unavailable — proceed without)",
  );

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-pattern-finder for partition ${opts.index} of ${opts.total}.`,
    `Find concrete code patterns inside the SCOPE that demonstrate how the`,
    `topic of the research question is currently expressed in the codebase.`,
    `Return runnable-looking snippets, not abstract descriptions.`,
    `</MISSION>`,
    ``,
    ...renderArchitecturalOrientation(opts.index, orientation),
    ``,
    `<SCOPE>`,
    assignment,
    ``,
    `(Quick comma-separated form for tool args: ${dirs})`,
    `</SCOPE>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `For each distinct pattern you find, output:`,
    ``,
    `#### Pattern: <short name>`,
    `**Where:** \`<repo-relative path>:<line>\``,
    `**What:** 1-sentence description.`,
    "```<language>",
    `<5-30 lines of actual code from the file>`,
    "```",
    `**Variations / call-sites:** other \`file.ts:line\` references using the same pattern.`,
    ``,
    `Aim for 3-7 distinct patterns. Skip anything tangential to the question.`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Restrict every grep/glob to the SCOPE above.`,
    `Quote code verbatim — never paraphrase a snippet.`,
    `Use file:line references for every claim.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

/** codebase-analyzer — document HOW the most relevant impl files work. */
export function buildAnalyzerPrompt(opts: {
  question: string;
  partition: PartitionUnit[];
  locatorOutput: string;
  scoutOverview: string;
  index: number;
  total: number;
}): string {
  const assignment = renderPartitionAssignment(opts.partition);
  const orientation = trimOr(
    opts.scoutOverview,
    "(scout overview unavailable — proceed without)",
  );
  const locator = trimOr(
    opts.locatorOutput,
    "(locator returned no files — analyse the partition directly)",
  );

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-analyzer for partition ${opts.index} of ${opts.total}.`,
    `The codebase-locator (your sibling) has already enumerated the files in`,
    `your partition that touch this topic. Your job is to read the 5-10 MOST`,
    `relevant IMPLEMENTATION files and document how they actually work, with`,
    `precise \`file.ts:line\` references throughout.`,
    `</MISSION>`,
    ``,
    ...renderArchitecturalOrientation(opts.index, orientation),
    ``,
    `<SCOPE>`,
    assignment,
    `</SCOPE>`,
    ``,
    `<LOCATOR_FINDINGS>`,
    `Verbatim output from the codebase-locator sibling for this partition —`,
    `pick the implementation files to read from the "Implementation" section:`,
    ``,
    locator,
    `</LOCATOR_FINDINGS>`,
    ``,
    `<METHOD>`,
    `1. From the locator findings above, choose 5-10 implementation files most`,
    `   central to the research question. Prefer files that look like the`,
    `   primary entry points or data-flow hubs.`,
    `2. Read each chosen file in full (no offset / no limit).`,
    `3. For each file, document:`,
    `     • Its role (1 sentence)`,
    `     • Key exported symbols with \`file.ts:line\` refs`,
    `     • Control flow tied to the research question`,
    `     • Data flow (what comes in, what goes out, where state lives)`,
    `     • External dependencies it imports (libraries, sibling modules)`,
    `4. After per-file documentation, write a short cross-cutting synthesis`,
    `   (≤200 words) describing how these files compose to address the topic.`,
    `5. List any files OUTSIDE this partition that you noticed are referenced`,
    `   from your reads (so the aggregator can stitch findings across`,
    `   partitions). One file per line: \`<repo-relative path>\` — 1-line reason.`,
    `</METHOD>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `Use this structure (omit empty sections):`,
    ``,
    `### Files Analysed`,
    `<bullet list of the 5-10 files you read, repo-relative paths>`,
    ``,
    `### Per-File Notes`,
    `#### \`<repo-relative path>\``,
    `- **Role:** ...`,
    `- **Key symbols:** \`name\` (\`file.ts:line\`), ...`,
    `- **Control flow:** ...`,
    `- **Data flow:** ...`,
    `- **Dependencies:** ...`,
    ``,
    `### Cross-Cutting Synthesis`,
    `<≤200 words on how these files compose to address the topic>`,
    ``,
    `### Out-of-Partition References`,
    `- \`<repo-relative path>\` — 1-line note on why it matters`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Use file:line references for every concrete claim — never abstract prose.`,
    `Read files in full; do not paginate via offset/limit unless a file is enormous.`,
    `Do NOT analyse files outside your partition — only LIST them as cross-refs.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

/** codebase-online-researcher — focused external doc fetch when libs are central. */
export function buildOnlineResearcherPrompt(opts: {
  question: string;
  partition: PartitionUnit[];
  locatorOutput: string;
  index: number;
  total: number;
}): string {
  const assignment = renderPartitionAssignment(opts.partition);
  const locator = trimOr(opts.locatorOutput, "(locator returned no files)");

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-online-researcher for partition ${opts.index} of ${opts.total}.`,
    `Decide whether external library / framework documentation is CENTRAL to`,
    `answering the research question for this partition. If yes, fetch focused`,
    `excerpts and tie them back to the partition's files. If no, output a`,
    `single-line "(no external research applicable)" and stop.`,
    `</MISSION>`,
    ``,
    `<SCOPE>`,
    assignment,
    `</SCOPE>`,
    ``,
    `<LOCATOR_FINDINGS>`,
    `Use this list to identify which third-party libraries / frameworks the`,
    `partition imports. If nothing relevant surfaces, return early.`,
    ``,
    locator,
    `</LOCATOR_FINDINGS>`,
    ``,
    `<METHOD>`,
    `1. Skim the locator output and any package manifests in the partition`,
    `   (package.json, go.mod, requirements.txt, Cargo.toml, etc.) to identify`,
    `   external dependencies that are LIKELY central to the research question.`,
    `2. If none qualify, output exactly:`,
    `     (no external research applicable)`,
    `   and end the turn with a one-sentence prose explanation of why.`,
    `3. If at least one qualifies, follow the token-efficient fetch order from`,
    `   your system prompt (llms.txt → Markdown for Agents → playwright-cli)`,
    `   to pull focused documentation excerpts.`,
    `4. For each library you researched, return:`,
    `     • Library name + version (if discoverable)`,
    `     • Key doc URLs you fetched`,
    `     • The specific behavior that bears on the research question`,
    `     • Where in the partition that behavior is exercised (\`file.ts:line\`)`,
    `</METHOD>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `If you skipped:`,
    ``,
    `(no external research applicable)`,
    ``,
    `<one-sentence justification>`,
    ``,
    `If you researched, repeat per library:`,
    ``,
    `#### <Library> (vX.Y)`,
    `**Docs:** <url>, <url>`,
    `**Relevant behaviour:** ...`,
    `**Where used:** \`<repo-relative path>:<line>\` — 1-line note`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Skipping is the correct answer when nothing is central — do NOT pad with`,
    `tutorials or general guides.`,
    `Quote URLs verbatim. Do NOT invent or paraphrase doc URLs.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1b — research-history specialists
// ─────────────────────────────────────────────────────────────────────────────

/** codebase-research-locator — find prior research docs about the topic. */
export function buildHistoryLocatorPrompt(opts: {
  question: string;
}): string {
  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-research-locator. Surface prior research documents`,
    `about this topic from the project's research/ directory so the analyzer`,
    `(your sibling) can extract insights from them.`,
    `</MISSION>`,
    ``,
    `<SCOPE>`,
    `Primary: \`research/\` (and standard subdirs: docs/, tickets/, notes/).`,
    `Secondary: any sibling research directories at the repository root that match`,
    `\`*research*\`, \`*adr*\`, \`*rfc*\`, or \`specs\`.`,
    ``,
    `If no research directory exists at all, return a single section:`,
    ``,
    `### No Prior Research`,
    `(briefly note what you checked)`,
    `</SCOPE>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `Group by document type. Within each group, sort newest first by filename.`,
    ``,
    `### Docs`,
    `- \`<repo-relative path>\` — 1-line title-derived summary`,
    ``,
    `### Tickets`,
    `- ...`,
    ``,
    `### Notes`,
    `- ...`,
    ``,
    `### Specs / ADRs / RFCs`,
    `- ...`,
    ``,
    `Omit empty sections.`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Do NOT read file contents in depth — your sibling does that.`,
    `Do NOT investigate live source files — that's the explorers' job.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

/** codebase-research-analyzer — synthesize insights from located research docs. */
export function buildHistoryAnalyzerPrompt(opts: {
  question: string;
  locatorOutput: string;
}): string {
  const locator = trimOr(opts.locatorOutput, "(no prior research surfaced)");

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the codebase-research-analyzer. Extract HIGH-VALUE insights from`,
    `the prior research documents your sibling located, and produce a tight`,
    `synthesis the aggregator can fold in as supplementary context.`,
    `</MISSION>`,
    ``,
    `<LOCATOR_FINDINGS>`,
    locator,
    `</LOCATOR_FINDINGS>`,
    ``,
    `<METHOD>`,
    `1. Pick the 3-5 MOST relevant documents from the locator output.`,
    `2. Read each in full.`,
    `3. For each, capture:`,
    `     • Prior decisions on related topics (and what was actually shipped)`,
    `     • Completed investigations and their conclusions`,
    `     • Open questions / unresolved threads still in flight`,
    `4. Filter aggressively — drop tangential mentions and outdated context.`,
    `5. Synthesize into a single ≤400-word block. Cite document paths inline.`,
    `</METHOD>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `### Documents Reviewed`,
    `- \`<repo-relative path>\` — 1-line takeaway`,
    ``,
    `### Synthesis`,
    `<≤400 words covering decisions, conclusions, and open questions, with`,
    `inline path citations like (\`research/docs/2025-…md\`)>`,
    ``,
    `If no relevant prior research exists, output a single sentence saying so.`,
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Stay under 400 words in the Synthesis section.`,
    `Do NOT investigate live source files — that's the explorers' job.`,
    `Do NOT write any new files — your output is consumed via session transcript.`,
    TRAILING_PROSE_REMINDER,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — aggregator
// ─────────────────────────────────────────────────────────────────────────────

export function buildAggregatorPrompt(opts: {
  question: string;
  totalLoc: number;
  totalFiles: number;
  explorerCount: number;
  explorerFiles: {
    index: number;
    scratchPath: string;
    partition: PartitionUnit[];
  }[];
  finalPath: string;
  scoutOverview: string;
  historyOverview: string;
}): string {
  const explorerSummary = opts.explorerFiles
    .map(
      (e) =>
        `- **Partition ${e.index}** → \`${e.scratchPath}\`\n  Covered: ${renderPartitionDirs(e.partition)}`,
    )
    .join("\n");

  const orientation = trimOr(opts.scoutOverview, "(scout overview unavailable)");
  const history = trimOr(
    opts.historyOverview,
    "(no historical research surfaced)",
  );

  return [
    `<RESEARCH_QUESTION>`,
    opts.question,
    `</RESEARCH_QUESTION>`,
    ``,
    `<MISSION>`,
    `You are the aggregator. ${opts.explorerCount} parallel partitions of the`,
    `codebase (${opts.totalLoc.toLocaleString()} LOC across ${opts.totalFiles.toLocaleString()} source files)`,
    `have each been investigated by four specialist sub-agents — codebase-locator,`,
    `codebase-pattern-finder, codebase-analyzer, and codebase-online-researcher`,
    `— dispatched directly via the agent SDK. The deterministic synthesis step`,
    `wrote one markdown findings file per partition. A separate research-history`,
    `pipeline (codebase-research-locator → codebase-research-analyzer) surveyed`,
    `the project's prior research documents. Your job: synthesise everything`,
    `into a single comprehensive research document.`,
    `</MISSION>`,
    ``,
    `<ARCHITECTURAL_ORIENTATION>`,
    orientation,
    `</ARCHITECTURAL_ORIENTATION>`,
    ``,
    `<HISTORICAL_CONTEXT>`,
    `Use as supplementary context — live findings take precedence:`,
    ``,
    history,
    `</HISTORICAL_CONTEXT>`,
    ``,
    `<EXPLORER_REPORTS>`,
    `Each file below has the same structure (Scope / Files in Scope / How It`,
    `Works / Patterns / External References / Out-of-Partition References).`,
    `Some files also contain \`## Callers\` and \`## Impact\` sections produced`,
    `deterministically by the CodeGraph library — treat those as authoritative.`,
    `These are LIVE evidence from the specialist sub-agents and take precedence`,
    `over historical context.`,
    ``,
    explorerSummary,
    `</EXPLORER_REPORTS>`,
    ``,
    `<METHOD>`,
    `1. Read EVERY explorer findings file in full using the Read tool with no`,
    `   offset or limit — these are not optional.`,
    `2. Cross-reference: stitch findings together across partitions using each`,
    `   file's "Out-of-Partition References" section.`,
    `3. Resolve contradictions by re-reading the underlying source files`,
    `   directly — do not paper over disagreements.`,
    `4. Integrate historical context where it adds value, but trust live`,
    `   findings when they conflict with history.`,
    `5. When a findings file contains a \`## Callers\` or \`## Impact\` section`,
    `   (written by the deterministic CodeGraph synthesis step), treat every row`,
    `   in those tables as an authoritative fact — computed by the graph, not`,
    `   inferred by an LLM. Preserve them verbatim in the final output: do not`,
    `   summarise, paraphrase, merge, or drop rows.`,
    `6. Write the final research document to: \`${opts.finalPath}\``,
    `7. After writing the file, output a ≤200-word executive summary as your`,
    `   final prose response so this transcript has content.`,
    `</METHOD>`,
    ``,
    `<OUTPUT_FORMAT>`,
    `The file at \`${opts.finalPath}\` must follow this structure:`,
    ``,
    "```markdown",
    `---`,
    `date: <today's date YYYY-MM-DD HH:MM:SS TZ — run \`date '+%Y-%m-%d %H:%M:%S %Z'\`>`,
    `researcher: deep-research-codebase workflow`,
    `git_commit: <run \`git rev-parse --verify HEAD\`>`,
    `branch: <run \`git branch --show-current\`>`,
    `repository: <repo name from \`basename \\$(git rev-parse --show-toplevel)\`>`,
    `topic: "<the original research question>"`,
    `tags: [research, codebase, deep-research]`,
    `status: complete`,
    `last_updated: <today's date YYYY-MM-DD>`,
    `---`,
    ``,
    `# Research: <short title>`,
    ``,
    `## Research Question`,
    `<verbatim original question>`,
    ``,
    `## Executive Summary`,
    `3-5 paragraph high-level answer with concrete evidence.`,
    ``,
    `## Detailed Findings`,
    ``,
    `### <Component / Area 1>`,
    `Description with file:line references.`,
    ``,
    `### <Component / Area 2>`,
    `...`,
    ``,
    `## Architecture & Patterns`,
    `Cross-cutting patterns observed across multiple partitions.`,
    ``,
    `## Code References`,
    `- \`path/to/file.ts:123\` — what's there`,
    ``,
    `## Callers & Impact (Deterministic)`,
    `Verbatim tables from the \`## Callers\` and \`## Impact\` sections of each`,
    `explorer findings file that contained CodeGraph data. Concatenate all`,
    `per-symbol subsections here unchanged. Omit this section only if NO`,
    `findings file contained a \`## Callers\` or \`## Impact\` section.`,
    ``,
    `## Historical Context (from research/)`,
    `Relevant insights from prior research, with paths. Omit if no history.`,
    ``,
    `## Open Questions`,
    `Areas needing further investigation.`,
    ``,
    `## Methodology`,
    `Generated by the deep-research-codebase workflow with ${opts.explorerCount} partitions`,
    `covering ${opts.totalFiles.toLocaleString()} source files (${opts.totalLoc.toLocaleString()} LOC).`,
    `Each partition was investigated by four specialist sub-agents dispatched`,
    `directly via the provider SDK's native agent parameter:`,
    `codebase-locator, codebase-pattern-finder, codebase-analyzer, and`,
    `codebase-online-researcher. A separate research-history pipeline ran`,
    `codebase-research-locator → codebase-research-analyzer over the project's`,
    `prior research documents.`,
    "```",
    `</OUTPUT_FORMAT>`,
    ``,
    `<CONSTRAINTS>`,
    DOCUMENTARIAN_DISCLAIMER,
    `Prefer concrete file:line references over abstract descriptions.`,
    `Do NOT skim explorer reports — read each one in full.`,
    `If two partitions contradict each other, re-read the underlying source files.`,
    `End with the required ≤200-word executive summary AFTER writing the file.`,
    `</CONSTRAINTS>`,
    ``,
    `<RESEARCH_QUESTION_REMINDER>`,
    opts.question,
    `</RESEARCH_QUESTION_REMINDER>`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — batched specialist dispatch (Task-tool fan-out)
// ─────────────────────────────────────────────────────────────────────────────
//
// To cap parallel SDK subprocesses, specialist invocations are grouped into
// "batch sessions" (see helpers/batching.ts). Each batch session is a single
// Claude Agent SDK call whose main thread dispatches up to N sub-agents via
// the Task tool. The sub-agents write their verbatim findings to per-task
// scratch files and reply with a single confirmation token, so the
// orchestrator's context grows by N short lines rather than N transcripts
// (filesystem-context skill).

/**
 * Wrap a specialist prompt with the "write to file, reply with token only"
 * envelope. The envelope is what the orchestrator hands to the Task tool's
 * `prompt` parameter — the inner specialist prompt is built by the existing
 * `buildLocatorPrompt` / `buildPatternFinderPrompt` / etc. and embedded
 * verbatim so prompt semantics stay identical to the unbatched workflow.
 */
export function wrapPromptForTaskDispatch(opts: {
  specialistPrompt: string;
  outputPath: string;
  agentLabel: string;
}): string {
  return [
    `<TASK_OUTPUT_CONTRACT>`,
    `Write your COMPLETE response — the verbatim markdown findings exactly as`,
    `the prompt below specifies — to this absolute path using the Write tool:`,
    ``,
    `  ${opts.outputPath}`,
    ``,
    `Then reply with exactly the single token "DONE" and nothing else. Your`,
    `parent only needs confirmation; the file is the real output. Do NOT`,
    `inline your findings into your reply, do NOT add commentary, do NOT`,
    `summarise — just write the file, then reply "DONE".`,
    ``,
    `If you cannot produce useful findings (e.g. the partition has nothing`,
    `relevant to the question), write a one-line sentinel to the file`,
    `explaining why, then still reply "DONE". Reply with`,
    `"FAILED: <one-line reason>" only if you could not even write the file.`,
    `</TASK_OUTPUT_CONTRACT>`,
    ``,
    `<${opts.agentLabel}_TASK>`,
    opts.specialistPrompt,
    `</${opts.agentLabel}_TASK>`,
  ].join("\n");
}

/**
 * Build the orchestrator prompt for a batch session. The orchestrator's job
 * is purely deterministic dispatch — fire one Task tool call per task in
 * **a single assistant message** so they execute in parallel, then report a
 * one-line tally. It must NOT inline sub-agent findings, paraphrase the
 * embedded prompts, or retry failures — siblings still run and synthesis
 * tolerates missing files.
 */
export function buildBatchOrchestratorPrompt(opts: {
  wave: 1 | 2;
  batchIndex: number;
  totalBatches: number;
  tasks: Array<{
    subagentType: string;
    prompt: string;
    outputPath: string;
  }>;
}): string {
  const taskBlocks = opts.tasks
    .map((t, i) =>
      [
        `### Task ${i + 1} of ${opts.tasks.length} — \`${t.subagentType}\``,
        `Output path the sub-agent will write to: \`${t.outputPath}\``,
        ``,
        `Verbatim prompt to pass as the Task tool's \`prompt\` parameter:`,
        ``,
        "````",
        t.prompt,
        "````",
        ``,
      ].join("\n"),
    )
    .join("\n");

  return [
    `<BATCH_DISPATCH_MISSION>`,
    `You are the deterministic dispatcher for batch ${opts.batchIndex} of`,
    `${opts.totalBatches} in wave ${opts.wave} of the deep-research-codebase`,
    `workflow. Your sole job is to spawn the ${opts.tasks.length} sub-agent`,
    `task${opts.tasks.length === 1 ? "" : "s"} listed below using the Task tool.`,
    `</BATCH_DISPATCH_MISSION>`,
    ``,
    `<DISPATCH_RULES>`,
    `1. Issue ALL ${opts.tasks.length} Task tool calls in a SINGLE assistant`,
    `   message (parallel tool use), not sequentially across multiple turns.`,
    `   Parallel dispatch is the only reason this batch exists — sequential`,
    `   calls defeat its purpose.`,
    `2. For each task: set \`subagent_type\` to the value shown, set \`prompt\``,
    `   to the verbatim text inside the fenced block (no paraphrasing,`,
    `   truncating, or added framing), and set \`description\` to a short`,
    `   3–5 word label.`,
    `3. Dispatch every task even if some look similar to others. Tasks here`,
    `   cover DIFFERENT codebase partitions or DIFFERENT specialist roles —`,
    `   apparent overlap is not real overlap. Do NOT merge, skip, or combine.`,
    `4. Do NOT inline any sub-agent's findings into your reply. The sub-agents`,
    `   write their output to disk; downstream stages read those files.`,
    `5. Do NOT retry failed sub-agents. Siblings still run and the synthesis`,
    `   step tolerates missing files.`,
    `</DISPATCH_RULES>`,
    ``,
    `<FINAL_REPLY_FORMAT>`,
    `After all sub-agents complete, your final assistant message must be`,
    `exactly one line of the form:`,
    ``,
    `  BATCH ${opts.batchIndex} COMPLETE: <ok>/${opts.tasks.length} ok, <failed> failed`,
    ``,
    `where <ok> is the count that replied "DONE" and <failed> is the count`,
    `that replied "FAILED" or otherwise did not produce a file.`,
    `</FINAL_REPLY_FORMAT>`,
    ``,
    `---`,
    ``,
    taskBlocks,
  ].join("\n");
}
