import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInputsPickerState, renderInputsPicker } from "../../packages/workflows/src/tui/inputs-picker.ts";
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { wrapPlainText } from "../../packages/workflows/src/tui/text-helpers.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { FIELDS } from "./inputs-picker-helpers.js";

export function registerInputsPickerSuite3(): void {
  // ── Rendering ─────────────────────────────────────────────────────────────

  test("wrapPlainText handles width=1 long words", () => {
    assert.deepEqual(wrapPlainText("abc", 1), ["a", "b", "c"]);
  });

  test("wrapPlainText preserves empty rows for empty and whitespace-only input", () => {
    assert.deepEqual(wrapPlainText("", 80), [""]);
    assert.deepEqual(wrapPlainText("   \t  ", 80), [""]);
  });

  test("renderInputsPicker uses boxed field styling for the active field", () => {
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS, { prompt: "build" });
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "ralph",
      fields: FIELDS,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(joined, /←\s+■ prompt/);
    assert.doesNotMatch(joined, /✓ Submit/);
    assert.match(joined, /╭ prompt ─+╮/);
    assert.match(joined, /│build/);
    assert.match(joined, /text · required · task to do/);
    assert.doesNotMatch(joined, /loop a thinker/);
    assert.match(joined, /WORKFLOW/);
    assert.match(joined, /ralph/);
    assert.match(joined, /1 \/ 4/);
    assert.match(joined, /╭/);
    assert.match(joined, /╰/);
    assert.doesNotMatch(joined, /Run workflow/);
    assert.match(joined, /enter Submit/);
    assert.doesNotMatch(joined, /ctrl\+x/);
    assert.doesNotMatch(joined, /Chat about this/);
    assert.match(joined, /esc Cancel/);
  });

  test("renderInputsPicker shows all questions with Submit at the end", () => {
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS, { prompt: "build a tui" });
    state.focusedIdx = FIELDS.length;
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "ralph",
      fields: FIELDS,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(joined, /╭ prompt ─+╮\n│build a tui/);
    assert.match(joined, /╭ iters ─+╮\n│5/);
    assert.match(joined, /╭ focus ─+╮\n│\s+1\. minimal\s+│\n│\s+2\. ✓ standard/);
    assert.match(joined, /╭ verbose ─+╮\n│\s+1\. on\s+│\n│\s+2\. ✓ off/);
    assert.match(joined, / SUBMIT /);
    assert.doesNotMatch(joined, /Review your inputs/);
    assert.doesNotMatch(joined, /Ready to submit your inputs\?/);
    assert.doesNotMatch(joined, /2\. Cancel/);
    assert.doesNotMatch(joined, /ctrl\+x/);
  });

  test("renderInputsPicker normalizes true-like boolean field values", () => {
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS, { prompt: "build a tui", verbose: 1 });
    state.focusedIdx = FIELDS.length;
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "ralph",
      fields: FIELDS,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(joined, /╭ verbose ─+╮\n│\s+1\. ✓ on\s+│\n│\s+2\. off/);
    assert.doesNotMatch(joined, /✓ off/);
  });

  test("renderInputsPicker shows empty boolean fields without selecting off", () => {
    const theme = deriveGraphTheme({});
    const fields: WorkflowInputEntry[] = [
      { name: "enabled", type: "boolean", required: true },
    ];
    const state = createInputsPickerState(fields);
    state.rawText.enabled = "";
    state.focusedIdx = fields.length;
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "ralph",
      fields,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(joined, /╭ enabled ─+╮\n│\s+1\. on\s+│\n│\s+2\. off/);
    assert.doesNotMatch(joined, /✓ off/);
  });

  test("renderInputsPicker wraps invalid Submit prompt instead of clipping", () => {
    const theme = deriveGraphTheme({});
    const fields: WorkflowInputEntry[] = [
      { name: "alpha_required_prompt", type: "string", required: true },
      { name: "beta_required_context", type: "string", required: true },
    ];
    const state = createInputsPickerState(fields);
    state.focusedIdx = fields.length;
    const width = 32;
    const lines = renderInputsPicker({
      width,
      theme,
      workflowName: "ralph",
      fields,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const joined = plainLines.join("\n");
    assert.match(joined, /Answer remaining inputs before/);
    assert.match(joined, /submitting:/);
    assert.match(joined, /alpha_required_prompt/);
    assert.match(joined, /beta_required_context/);
    assert.match(joined, / SUBMIT /);
    const promptStart = plainLines.findIndex((line) => line.startsWith("Answer remaining"));
    const promptLines = plainLines.slice(promptStart, promptStart + 4).join("\n");
    assert.doesNotMatch(promptLines, /…/);
    for (const line of plainLines) assert.ok(line.length <= width, `row exceeds width: ${JSON.stringify(line)}`);
  });

  test("renderInputsPicker preserves multiline values on the single page", () => {
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS, { prompt: "line one\nline two" });
    state.focusedIdx = FIELDS.length;
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "ralph",
      fields: FIELDS,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(joined, /│line one\s+│\n│line two/);
    assert.doesNotMatch(joined, /line one line two/);
  });

  test("renderInputsPicker keeps Submit visible in a narrow tab bar", () => {
    const theme = deriveGraphTheme({});
    const fields: WorkflowInputEntry[] = [
      { name: "very_long_prompt_name", type: "string", required: true },
      { name: "another_long_context_name", type: "string", required: false },
    ];
    const state = createInputsPickerState(fields, { very_long_prompt_name: "ready" });
    state.focusedIdx = fields.length;
    const lines = renderInputsPicker({
      width: 16,
      theme,
      workflowName: "ralph",
      fields,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const footer = (lines.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(footer, /SUBMIT/);
    assert.ok(footer.length <= 16);
  });

  test("renderInputsPicker renders all inputs as boxed fields", () => {
    const theme = deriveGraphTheme({});
    const width = 80;
    const state = createInputsPickerState(FIELDS);
    const lines = renderInputsPicker({
      width,
      theme,
      workflowName: "ralph",
      fields: FIELDS,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    const plain = lines.map(stripAnsi);

    assert.ok(plain.some((row) => row.startsWith("╭ prompt ")), "prompt should render as a field box");
    assert.ok(plain.some((row) => /^│5\s+│$/.test(row)), "scalar fields should render without numbering");
    assert.ok(plain.some((row) => /^│\s+1\. minimal/.test(row)), "choice lists should keep numbering");
    for (const row of plain) {
      assert.ok(row.length <= width, `row exceeds width: ${JSON.stringify(row)}`);
    }
  });

  test("renderInputsPicker wraps long descriptions and choice labels without ellipses", () => {
    const theme = deriveGraphTheme({});
    const fields: WorkflowInputEntry[] = [
      {
        name: "strategy",
        type: "select",
        required: true,
        description: "Choose the deployment strategy that prioritizes safety across multiple production regions and rollback windows.",
        choices: ["roll out gradually across production regions with automated rollback and operator checkpoints"],
      },
    ];
    const state = createInputsPickerState(fields);
    const lines = renderInputsPicker({
      width: 80,
      theme,
      workflowName: "deploy",
      fields,
      state,
      cursorOn: true,
    });
    // eslint-disable-next-line no-control-regex
    const joined = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(joined, /prioritizes safety/);
    assert.match(joined, /across multiple production regions and rollback windows/);
    assert.match(joined, /roll out gradually across production regions/);
    assert.match(joined, /automated rollback and/);
    assert.match(joined, /operator checkpoints/);
    assert.doesNotMatch(joined, /…/);
  });

  test("renderInputsPicker stays well-formed across a wide range of widths (resize sweep)", () => {
    // Simulates a user resizing their terminal mid-picker. Every width from tight
    // to ultra-wide must keep list rows and footer hints inside the terminal.
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS);
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    for (const width of [20, 30, 40, 60, 80, 100, 120, 160, 200, 320]) {
      const lines = renderInputsPicker({
        width,
        theme,
        workflowName: "deep-research-codebase",
        fields: FIELDS,
        state,
        cursorOn: true,
      });
      const plain = lines.map(stripAnsi);

      for (const row of plain) {
        assert.ok(
          row.length <= width,
          `width=${width}: row exceeds budget (${row.length} > ${width}): ${JSON.stringify(row)}`,
        );

      }
    }
  });

  test("renderInputsPicker footer uses compact static submit button", () => {
    const theme = deriveGraphTheme({});
    const state = createInputsPickerState(FIELDS);
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    const renderFooterAt = (width: number): string =>
      stripAnsi(renderInputsPicker({
        width,
        theme,
        workflowName: "ralph",
        fields: FIELDS,
        state,
        cursorOn: true,
      }).at(-1) ?? "");

    const wide = renderFooterAt(120);
    assert.match(wide, / SUBMIT /);
    assert.doesNotMatch(wide, /EDIT/);
    assert.match(wide, /enter Submit/);
    assert.match(wide, /tab Next/);
    assert.match(wide, /shift\+tab Prev/);
    assert.match(wide, /esc Cancel/);
    assert.doesNotMatch(wide, /ctrl\+x/);

    const narrow = renderFooterAt(24);
    assert.ok(narrow.length <= 24);
    assert.match(narrow, /SUBMIT|…/);
  });

  // ── renderInputsSchema ────────────────────────────────────────────────────

  test("renderInputsSchema (plain) emits rounded panel and field rows", () => {
    const out = renderInputsSchema("demo", FIELDS);
    assert.match(out, /╭ INPUTS FOR demo /);
    assert.match(out, /prompt  text  ·  required/);
    assert.match(out, /task to do/);
    assert.match(out, /iters  number  ·  optional/);
    assert.match(out, /default: 5/);
    assert.match(out, /values: minimal  ·  standard  ·  exhaustive/);
  });

  test("renderInputsSchema (pretty) emits themed header and field blocks", () => {
    const theme = deriveGraphTheme({});
    const ansi = renderInputsSchema("demo", FIELDS, { theme });
    // eslint-disable-next-line no-control-regex
    const out = ansi.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /INPUTS FOR DEMO/);
    assert.match(out, /prompt/);
    assert.match(out, /text/);
    assert.match(out, /required/);
    assert.match(out, /optional/);
    assert.match(out, /values: /);
    assert.match(out, /minimal/);
    assert.match(out, /default: 5/);
    assert.match(out, /4 inputs/);
    assert.match(out, /2 required/);
    assert.match(out, /pass via key=value or run/);
  });

  test("renderInputsSchema returns rounded zero-input panel", () => {
    const out = renderInputsSchema("nullary", []);
    assert.match(out, /╭ INPUTS FOR nullary /);
    assert.match(out, /Workflow has no declared inputs\./);
  });
}
