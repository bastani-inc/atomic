import { defineWorkflow } from "@bastani/workflows";

const DEFAULT_LINE_COUNT = 72;

type PromptKind = "input" | "confirm" | "select" | "editor";

function normalizeLineCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LINE_COUNT;
  return Math.max(24, Math.min(180, Math.floor(value)));
}

function longPrompt(kind: PromptKind, lineCount: number): string {
  const upper = kind.toUpperCase();
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const line = index + 1;
    return `${upper} PROMPT LINE ${String(line).padStart(3, "0")}: PR 1144 archived prompt scroll verification filler; keep this line visible only after scrolling.`;
  });
  return [
    `PR1144 ${upper} PROMPT TOP MARKER`,
    `This ${kind} prompt intentionally exceeds the stage-chat viewport. Scroll while it is active, answer it, then reattach to the completed prompt node and verify the archive still scrolls.`,
    "",
    ...lines,
    "",
    `PR1144 ${upper} PROMPT BOTTOM MARKER`,
  ].join("\n");
}

function selectOptions(lineCount: number): readonly string[] {
  return [
    "alpha-short-choice",
    [
      "bravo-long-choice: PR1144 SELECT CHOICE TOP MARKER",
      ...Array.from({ length: Math.max(8, Math.floor(lineCount / 3)) }, (_, index) => `select choice detail line ${index + 1}`),
      "bravo-long-choice: PR1144 SELECT CHOICE BOTTOM MARKER",
    ].join(" | "),
    "charlie-final-choice",
  ] as const;
}

function editorInitial(lineCount: number): string {
  return [
    "PR1144 EDITOR INITIAL TOP MARKER",
    "Edit this document, optionally add a response marker, then submit it. The completed archive should show both the long initial value and the saved response after scrolling.",
    "",
    ...Array.from({ length: lineCount }, (_, index) => {
      const line = index + 1;
      return JSON.stringify({
        line,
        check: "completed HIL editor archive remains scrollable after reattach",
        action: "scroll active editor, submit, reattach, scroll archived editor prompt",
      });
    }),
    "",
    "PR1144 EDITOR INITIAL BOTTOM MARKER",
  ].join("\n");
}

export default defineWorkflow("hil-archive-scroll")
  .description("Manual workflow: creates long ctx.ui input/confirm/select/editor prompt nodes so completed HIL archives can be reattached and scrolled with keyboard and mouse wheel.")
  .input("line_count", {
    type: "number",
    default: DEFAULT_LINE_COUNT,
    description: "Number of filler lines generated for each long HIL prompt. Defaults to 72.",
  })
  .run(async (ctx) => {
    const lineCount = normalizeLineCount(ctx.inputs.line_count);

    const inputResponse = await ctx.ui.input(longPrompt("input", lineCount));
    const confirmed = await ctx.ui.confirm(longPrompt("confirm", lineCount));
    const selected = await ctx.ui.select(longPrompt("select", lineCount), selectOptions(lineCount));
    const edited = await ctx.ui.editor(editorInitial(lineCount));

    return {
      lineCount,
      inputResponseLength: inputResponse.length,
      confirmed,
      selected,
      editedLength: edited.length,
      manualVerification: [
        "For each completed HIL prompt node, reattach from the graph and verify PageDown/Home/End plus mouse wheel reveal TOP and BOTTOM markers.",
        "Confirm Ctrl+D still returns to the graph and Escape still closes the read-only archive.",
      ],
    };
  })
  .compile();

