import { defineWorkflow, Type } from "@bastani/workflows";

const DEFAULT_LONG_LINES = 80;

function normalizeLongLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LONG_LINES;
  return Math.max(8, Math.min(250, Math.floor(value)));
}

function buildApprovalJson(): string {
  return JSON.stringify(
    [
      {
        index: 1,
        approved: true,
        author: "dummy-user",
        targetUrl: "https://example.com/dummy-post",
        message: "This is a short editable HIL approval message.",
      },
      {
        index: 2,
        approved: false,
        author: "another-dummy-user",
        targetUrl: "https://example.com/another-dummy-post",
        message: "Flip approved to true or edit this text if you want.",
      },
    ],
    null,
    2,
  );
}

function buildLongConfirmText(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = index + 1;
    return `LONG CONFIRM LINE ${line}: this is filler text for testing workflow HIL scrolling in the attached prompt view.`;
  }).join("\n");
}

function buildLongEditorText(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = index + 1;
    return JSON.stringify({
      line,
      approved: line % 2 === 1,
      message: `Editable long editor row ${line}; use PageUp/PageDown/Home/End to test scrolling.`,
    });
  }).join("\n");
}

export default defineWorkflow("hil-dummy")
  .description("Tiny workflow for manually testing ctx.ui.editor and ctx.ui.confirm HIL prompt nodes, including long-text scrolling.")
  .input(
    "long_lines",
    Type.Number({
      default: DEFAULT_LONG_LINES,
      description: "Number of lines to generate for the long confirm/editor HIL prompts. Defaults to 80.",
    }),
  )
  .output("shortConfirmed", Type.Boolean())
  .output("longConfirmed", Type.Boolean())
  .output("editedApprovalJsonLength", Type.Number())
  .output("longEditedDocumentLength", Type.Number())
  .output("longLines", Type.Number())
  .run(async (ctx) => {
    const longLines = normalizeLongLines(ctx.inputs.long_lines);

    await ctx.stage("setup", { noTools: "all" }).prompt(
      [
        "This is a tiny setup stage for the hil-dummy workflow.",
        "Reply exactly: READY",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    const editedApprovalJson = await ctx.ui.editor(buildApprovalJson());

    const shortConfirmed = await ctx.ui.confirm(
      `Short confirm after editor: edited document length is ${editedApprovalJson.length}. Continue through the long HIL prompts?`,
    );

    const longConfirmed = await ctx.ui.confirm(
      [
        "Long confirm prompt for scroll testing.",
        "Use this to verify the attached HIL view can scroll and still answer yes/no.",
        "",
        buildLongConfirmText(longLines),
      ].join("\n"),
    );

    const longEditedDocument = await ctx.ui.editor(buildLongEditorText(longLines));

    return {
      shortConfirmed,
      longConfirmed,
      editedApprovalJsonLength: editedApprovalJson.length,
      longEditedDocumentLength: longEditedDocument.length,
      longLines,
    };
  })
  .compile();
