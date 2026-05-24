/**
 * Unit tests for src/tui/inputs-picker.ts and src/shared/render-inputs-schema.ts.
 *
 * Covers:
 *   - createInputsPickerState seeds defaults, choices, and prefilled values
 *   - handleInputsPickerInput dispatches per type (string/select/boolean)
 *   - validation flags required fields and refuses submit until all valid
 *   - Submit tab commits valid input and focuses invalid fields otherwise
 *   - coerceValues maps rawText to typed objects (number/bool/select)
 *   - renderInputsPicker mirrors ask_user_question tabs, field rows, footer hints
 *   - renderInputsSchema pretty/plain modes both produce expected content
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  coerceValues,
  createInputsPickerState,
  handleInputsPickerInput,
  invalidForField,
  renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.ts";
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { wrapPlainText } from "../../packages/workflows/src/tui/text-helpers.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

const KB = makeFakeKeybindings();

const FIELDS: WorkflowInputEntry[] = [
  { name: "prompt", type: "text", required: true, description: "task to do" },
  { name: "iters", type: "number", required: false, default: 5 },
  {
    name: "focus",
    type: "select",
    required: true,
    choices: ["minimal", "standard", "exhaustive"],
    default: "standard",
  },
  { name: "verbose", type: "boolean", required: false },
];

// ── State construction ─────────────────────────────────────────────────────

test("createInputsPickerState seeds defaults, selects, and booleans", () => {
  const s = createInputsPickerState(FIELDS);
  assert.equal(s.rawText.prompt, "");
  assert.equal(s.rawText.iters, "5");
  assert.equal(s.rawText.focus, "standard");
  assert.equal(s.rawText.verbose, "false");
  // First invalid field (prompt) is focused.
  assert.equal(s.focusedIdx, 0);
});

test("createInputsPickerState respects prefilled values from CLI tokens", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "build x", focus: "minimal" });
  assert.equal(s.rawText.prompt, "build x");
  assert.equal(s.rawText.focus, "minimal");
  // Both required fields satisfied → focus on first field (idx 0).
  assert.equal(s.focusedIdx, 0);
});

test("createInputsPickerState seeds select first-choice when no default", () => {
  const fields: WorkflowInputEntry[] = [
    { name: "mode", type: "select", required: true, choices: ["a", "b", "c"] },
  ];
  const s = createInputsPickerState(fields);
  assert.equal(s.rawText.mode, "a");
});

// ── Validation ─────────────────────────────────────────────────────────────

test("invalidForField flags required+empty and non-numeric numbers", () => {
  assert.equal(invalidForField(FIELDS[0]!, "", 0), "required");
  assert.equal(invalidForField(FIELDS[0]!, "hi", 0), null);
  assert.equal(invalidForField(FIELDS[1]!, "abc", 1), "must be a number");
  assert.equal(invalidForField(FIELDS[1]!, "42", 1), null);
  assert.equal(invalidForField(FIELDS[1]!, "", 1), null); // optional, empty ok
});

test("invalidForField rejects select values not in choices", () => {
  assert.equal(invalidForField(FIELDS[2]!, "weird", 2), "not in choices");
  assert.equal(invalidForField(FIELDS[2]!, "standard", 2), null);
});

// ── Key handling ───────────────────────────────────────────────────────────

test("text field: typing inserts characters, backspace removes", () => {
  const s = createInputsPickerState(FIELDS);
  handleInputsPickerInput("h", s, FIELDS, KB);
  handleInputsPickerInput("i", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "hi");
  assert.equal(s.caret, 2);
  handleInputsPickerInput("\x7f", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "h");
  assert.equal(s.caret, 1);
});

test("text field accepts encoded printable key sequences", () => {
  for (const [key, expected] of [
    ["\x1b[98;1u", "b"], // Kitty / CSI-u plain b
    ["\x1b[65;2u", "A"], // Kitty / CSI-u shifted A
    ["\x1b[27;1;98~", "b"], // xterm modifyOtherKeys plain b
    ["\x1b[27;2;65~", "A"], // xterm modifyOtherKeys shifted A
  ] as const) {
    const s = createInputsPickerState(FIELDS);
    handleInputsPickerInput(key, s, FIELDS, KB);
    assert.equal(s.rawText.prompt, expected, `key=${JSON.stringify(key)}`);
    assert.equal(s.caret, expected.length, `key=${JSON.stringify(key)}`);
  }
});

test("text field: CJK, emoji, and combining-mark edits move by grapheme", () => {
  const s = createInputsPickerState(FIELDS);
  handleInputsPickerInput("漢", s, FIELDS, KB);
  handleInputsPickerInput("👩‍💻", s, FIELDS, KB);
  handleInputsPickerInput("e", s, FIELDS, KB);
  handleInputsPickerInput("\u0301", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "漢👩‍💻é");
  assert.equal(s.caret, "漢👩‍💻é".length);

  handleInputsPickerInput("\x1b[D", s, FIELDS, KB); // left over the composed é
  assert.equal(s.caret, "漢👩‍💻".length);
  handleInputsPickerInput("\x7f", s, FIELDS, KB); // delete the whole emoji cluster
  assert.equal(s.rawText.prompt, "漢é");
  assert.equal(s.caret, "漢".length);
});

test("tab and shift+tab move focus, wrapping", () => {
  const s = createInputsPickerState(FIELDS);
  assert.equal(s.focusedIdx, 0);
  handleInputsPickerInput("\t", s, FIELDS, KB);
  assert.equal(s.focusedIdx, 1);
  handleInputsPickerInput("\x1b[Z", s, FIELDS, KB);
  assert.equal(s.focusedIdx, 0);
  // Wrap backward from 0 → Submit section.
  handleInputsPickerInput("\x1b[Z", s, FIELDS, KB);
  assert.equal(s.focusedIdx, FIELDS.length);
  // Tab from the last field moves to Submit, then wraps to the first field.
  s.focusedIdx = FIELDS.length - 1;
  handleInputsPickerInput("\t", s, FIELDS, KB);
  assert.equal(s.focusedIdx, FIELDS.length);
  handleInputsPickerInput("\t", s, FIELDS, KB);
  assert.equal(s.focusedIdx, 0);
});

test("select field: arrows cycle through choices", () => {
  const s = createInputsPickerState(FIELDS);
  s.focusedIdx = 2; // focus on `focus` field
  assert.equal(s.rawText.focus, "standard");
  handleInputsPickerInput("\x1b[C", s, FIELDS, KB); // right
  assert.equal(s.rawText.focus, "exhaustive");
  handleInputsPickerInput("\x1b[C", s, FIELDS, KB); // wraps
  assert.equal(s.rawText.focus, "minimal");
  handleInputsPickerInput("\x1b[D", s, FIELDS, KB); // wraps back
  assert.equal(s.rawText.focus, "exhaustive");
});

test("select field: up/down navigate choices without leaving the field", () => {
  const s = createInputsPickerState(FIELDS);
  s.focusedIdx = 2; // focus on `focus` field
  assert.equal(s.rawText.focus, "standard");
  handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // down
  assert.equal(s.rawText.focus, "exhaustive");
  assert.equal(s.focusedIdx, 2);
  handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // wraps
  assert.equal(s.rawText.focus, "minimal");
  assert.equal(s.focusedIdx, 2);
  handleInputsPickerInput("\x1b[A", s, FIELDS, KB); // up wraps back
  assert.equal(s.rawText.focus, "exhaustive");
  assert.equal(s.focusedIdx, 2);
});

test("boolean field: space and arrows flip", () => {
  const s = createInputsPickerState(FIELDS);
  s.focusedIdx = 3;
  assert.equal(s.rawText.verbose, "false");
  handleInputsPickerInput(" ", s, FIELDS, KB);
  assert.equal(s.rawText.verbose, "true");
  handleInputsPickerInput("\x1b[D", s, FIELDS, KB);
  assert.equal(s.rawText.verbose, "false");
});

test("boolean field: up/down navigate on/off without leaving the field", () => {
  const s = createInputsPickerState(FIELDS);
  s.focusedIdx = 3;
  s.rawText.verbose = "true";
  handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // down to off
  assert.equal(s.rawText.verbose, "false");
  assert.equal(s.focusedIdx, 3);
  handleInputsPickerInput("\x1b[B", s, FIELDS, KB); // wraps to on
  assert.equal(s.rawText.verbose, "true");
  assert.equal(s.focusedIdx, 3);
  handleInputsPickerInput("\x1b[A", s, FIELDS, KB); // up wraps to off
  assert.equal(s.rawText.verbose, "false");
  assert.equal(s.focusedIdx, 3);
});

test("esc variants and ctrl+c variants cancel from form mode", () => {
  for (const key of [
    "\x1b",
    "\x1b[27u",
    "\x1b[27;1;27~",
    "\x03",
    "\x1b[99;5u",
    "\x1b[99;5:1u",
    "\x1b[27;5;99~",
  ]) {
    const state = createInputsPickerState(FIELDS);
    const action = handleInputsPickerInput(key, state, FIELDS, KB);
    assert.deepEqual(action, { kind: "cancel" }, `key=${JSON.stringify(key)}`);
  }
});

test("ctrl+x no longer submits or changes focus", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "build something" });
  s.focusedIdx = 0;
  const action = handleInputsPickerInput("\x18", s, FIELDS, KB);
  assert.deepEqual(action, { kind: "noop" });
  assert.equal(s.focusedIdx, 0);
});

test("Submit tab with missing required fields focuses invalid", () => {
  const s = createInputsPickerState(FIELDS);
  s.focusedIdx = FIELDS.length;
  const action = handleInputsPickerInput("\r", s, FIELDS, KB);
  assert.deepEqual(action, { kind: "noop" });
  assert.equal(s.focusedIdx, 0);
  assert.equal(s.submitChoiceIdx, 0);
  assert.deepEqual(s.invalidIndices, [0]);
});

test("Submit button returns coerced values", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
  s.rawText.iters = "8";
  s.rawText.verbose = "true";
  s.focusedIdx = FIELDS.length;

  const run = handleInputsPickerInput("\r", s, FIELDS, KB);
  assert.equal(run.kind, "run");
  if (run.kind === "run") {
    assert.deepEqual(run.values, {
      prompt: "hi",
      iters: 8,
      focus: "minimal",
      verbose: true,
    });
  }
});

test("Submit button ignores numeric hotkeys", () => {
  const submit = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
  submit.focusedIdx = FIELDS.length;
  const run = handleInputsPickerInput("1", submit, FIELDS, KB);
  assert.equal(run.kind, "noop");
});

test("Submit button arrow keys return to the questions", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "hi", focus: "minimal" });
  s.focusedIdx = FIELDS.length;

  handleInputsPickerInput("\x1b[A", s, FIELDS, KB);
  assert.equal(s.focusedIdx, FIELDS.length - 1);
  s.focusedIdx = FIELDS.length;
  handleInputsPickerInput("\x1b[B", s, FIELDS, KB);
  assert.equal(s.focusedIdx, 0);
});

// ── Coercion ──────────────────────────────────────────────────────────────

test("coerceValues maps types correctly and skips empty optionals", () => {
  const out = coerceValues(FIELDS, {
    prompt: "do x",
    iters: "10",
    focus: "exhaustive",
    verbose: "true",
  });
  assert.deepEqual(out, {
    prompt: "do x",
    iters: 10,
    focus: "exhaustive",
    verbose: true,
  });

  const sparse = coerceValues(FIELDS, {
    prompt: "y",
    iters: "",
    focus: "standard",
    verbose: "false",
  });
  // iters is empty + optional → omitted; verbose still recorded
  assert.equal(sparse.iters, undefined);
  assert.equal(sparse.verbose, false);
});

test("coerceValues parses JSON-shaped text values", () => {
  const fields: WorkflowInputEntry[] = [
    { name: "tags", type: "text", required: false },
  ];
  const out = coerceValues(fields, { tags: '["a","b"]' });
  assert.deepEqual(out.tags, ["a", "b"]);
});

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

// ── injected keybindings: word / line / char editing (picker overlay) ──────

test("picker: ctrl+w deletes the word left of the caret", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
  s.caret = 16; // end of "gamma"
  handleInputsPickerInput("\x17", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "alpha beta ");
  assert.equal(s.caret, 11);
});

test("picker: ctrl+u deletes from caret to logical line start", () => {
  const s = createInputsPickerState(FIELDS, {
    prompt: "line one\nline two\nline three",
  });
  s.caret = 14; // mid "line two": 9 + 5
  handleInputsPickerInput("\x15", s, FIELDS, KB);
  // Deletes "line " from line-two only; surrounding lines stay intact.
  assert.equal(s.rawText.prompt, "line one\ntwo\nline three");
  assert.equal(s.caret, 9);
});

test("picker: ctrl+k deletes from caret to logical line end without crossing newlines", () => {
  const s = createInputsPickerState(FIELDS, {
    prompt: "line one\nline two\nline three",
  });
  s.caret = 13; // mid "line two": 9 + 4 (after "line")
  handleInputsPickerInput("\x0b", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "line one\nline\nline three");
  assert.equal(s.caret, 13);
});

test("picker: ctrl+a / ctrl+e jump to logical line start / end", () => {
  const s = createInputsPickerState(FIELDS, {
    prompt: "first line\nsecond line",
  });
  s.caret = 14; // inside "second line"
  handleInputsPickerInput("\x01", s, FIELDS, KB);
  assert.equal(s.caret, 11);
  handleInputsPickerInput("\x05", s, FIELDS, KB);
  assert.equal(s.caret, 22);
});

test("picker: alt+d deletes the word right of the caret", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
  s.caret = 6; // start of "beta"
  handleInputsPickerInput("\x1bd", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "alpha  gamma");
  assert.equal(s.caret, 6);
});

test("picker: alt+left / alt+right jump by whole word", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "alpha beta gamma" });
  s.caret = 16; // end
  handleInputsPickerInput("\x1b[1;3D", s, FIELDS, KB);
  assert.equal(s.caret, 11); // start of "gamma"
  handleInputsPickerInput("\x1b[1;3D", s, FIELDS, KB);
  assert.equal(s.caret, 6); // start of "beta"
  handleInputsPickerInput("\x1b[1;3C", s, FIELDS, KB);
  assert.equal(s.caret, 10); // end of "beta"
});

test("picker: ctrl+d deletes the char right of the caret", () => {
  const s = createInputsPickerState(FIELDS, { prompt: "abc" });
  s.caret = 1;
  handleInputsPickerInput("\x04", s, FIELDS, KB);
  assert.equal(s.rawText.prompt, "ac");
  assert.equal(s.caret, 1);
});

test("picker: user-remapped delete word backward respects injected keybindings", () => {
  const kb = makeFakeKeybindings({
    "tui.editor.deleteWordBackward": ["\x14"], // ctrl+t
  });
  const s = createInputsPickerState(FIELDS, { prompt: "one two" });
  s.caret = 7;
  handleInputsPickerInput("\x14", s, FIELDS, kb);
  assert.equal(s.rawText.prompt, "one ");
  assert.equal(s.caret, 4);
  // Original ctrl+w no longer triggers the action under override.
  s.rawText.prompt = "alpha beta";
  s.caret = 10;
  handleInputsPickerInput("\x17", s, FIELDS, kb);
  assert.equal(s.rawText.prompt, "alpha beta");
  assert.equal(s.caret, 10);
});
