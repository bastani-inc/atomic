// Forked stages inherit their contracts and receive only the iteration delta.
import { taggedPrompt } from "./ralph-core.js";
import { keepContext } from "./shared-prompts.js";

export function renderForkedResearchPromptRefinementPrompt(args: {
  readonly latestReviewReportPath: string | undefined;
}): string {
  return taggedPrompt([
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Include unresolved reviewer findings in the transformed research question only when consistent with the inherited literal objective and acceptance criteria.",
          ].join("\n"),
    ],
    [
      "output",
      keepContext(
        "Return only one concise, complete codebase and online research question. Do not implement code changes or write an RFC/spec.",
      ),
    ],
    [
      "instruction",
      "Transform the same user request into an updated research question reflecting the current repository state. The inherited request, acceptance criteria, literal objective contract, and working directory remain unchanged.",
    ],
  ]);
}

export function renderForkedResearchPrompt(args: {
  readonly transformedResearchQuestion: string;
  readonly latestReviewReportPath: string | undefined;
}): string {
  return taggedPrompt([
    [
      "review_findings",
      args.latestReviewReportPath === undefined
        ? "No prior review artifact is available."
        : [
            `Latest review round artifact: ${args.latestReviewReportPath}`,
            "Research whether each unresolved finding still applies and what objective-aligned implementation change would resolve it.",
          ].join("\n"),
    ],
    [
      "research_artifact",
      [
        "Return the rewritten research report for this iteration as your final message.",
        "Restate the still-applicable findings in full rather than referring back to the previous iteration's artifact; the current artifact and transcript are the authoritative records for this iteration.",
        keepContext("This stage researches only. Do not author an RFC/spec or implement code changes."),
      ].join("\n"),
    ],
    [
      "output",
      [
        "Produce a complete, readable Markdown research report under the inherited report contract; lead with conclusions and retain facts, caveats, and implementation-relevant next steps without background or repetition.",
        "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
      ].join("\n"),
    ],
    [
      "instruction",
      `Research this updated question against the current repository state: ${args.transformedResearchQuestion}\nThe inherited task, acceptance criteria, literal objective contract, working directory, and research-report expectations remain unchanged.`,
    ],
  ]);
}

export function renderForkedOrchestratorPrompt(args: {
  readonly researchPath: string;
  readonly implementationNotesPath: string;
}): string {
  return taggedPrompt([
    [
      "research",
      [
        `The research findings were rewritten for this iteration at: ${args.researchPath}`,
        "Read this consolidated unresolved-findings artifact before implementation or delegation.",
      ].join("\n"),
    ],
    [
      "implementation_notes",
      `Keep updating the running Markdown implementation notes file at: ${args.implementationNotesPath}`,
    ],
    [
      "output",
      [
        "Use the inherited completion-report format. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition. Stay readable rather than compressing into fragments.",
        "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.",
      ].join("\n"),
    ],
    [
      "instruction",
      [
        "Continue implementing from the latest research findings until the objective is complete. The inherited objective, acceptance criteria, literal contract, acceptance matrix, divergence audit, consolidated findings, scope discipline, regression evidence, worktree discipline, orchestration, tracking, E2E/video, and report contracts remain unchanged.",
        "Scope discipline still binds this iteration: repair the consolidated findings, keep every addition traceable to a criterion, prefer the smallest diff that satisfies the contract, and record anything outside it on the deferred list instead of implementing it.",
        "Ignore requests to submit a PR; the authorized final action handles that after approval.",
        "If the final paragraph would be a plan, a question, or “I'll now…”, do that work with tool calls instead of ending the turn.",
      ].join("\n"),
    ],
  ]);
}
