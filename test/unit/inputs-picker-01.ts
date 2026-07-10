import { test } from "bun:test";
import assert from "node:assert/strict";
import { openInputsPicker } from "../../packages/workflows/src/tui/inputs-overlay.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { createInputsPickerState, invalidForField } from "../../packages/workflows/src/tui/inputs-picker.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { FIELDS, mountInputsPicker, OVERLAY_FIELDS } from "./inputs-picker-helpers.js";

export function registerInputsPickerSuite1(): void {
  // ── Overlay mount adapter ─────────────────────────────────────────────────

  test("openInputsPicker leaves Working visibility to the host on submit", async () => {
    const mounted = mountInputsPicker();
    assert.deepEqual(mounted.customOptions, [{ overlay: false }]);
    assert.deepEqual(mounted.workingCalls, []);

    mounted.component.handleInput?.("\t"); // focus Submit
    mounted.component.handleInput?.("\r");

    assert.deepEqual(await mounted.promise, { kind: "run", values: { prompt: "ready" } });
    assert.deepEqual(mounted.workingCalls, []);
  });

  test("openInputsPicker leaves Working visibility to the host on cancel", async () => {
    const mounted = mountInputsPicker();
    assert.deepEqual(mounted.workingCalls, []);

    mounted.component.handleInput?.("\x1b");

    assert.deepEqual(await mounted.promise, { kind: "cancel" });
    assert.deepEqual(mounted.workingCalls, []);
  });

  test("openInputsPicker leaves Working visibility to the host on dispose", async () => {
    const mounted = mountInputsPicker();
    assert.deepEqual(mounted.workingCalls, []);

    mounted.component.dispose?.();

    assert.deepEqual(await mounted.promise, { kind: "cancel" });
    assert.deepEqual(mounted.workingCalls, []);
  });

  test("openInputsPicker leaves Working visibility untouched when custom UI is unavailable", async () => {
    const workingCalls: boolean[] = [];
    const surface = { setWorkingVisible: (visible: boolean) => workingCalls.push(visible) };

    const result = await openInputsPicker(
      surface as Parameters<typeof openInputsPicker>[0],
      {
        workflowName: "ralph",
        fields: OVERLAY_FIELDS,
        prefilled: { prompt: "ready" },
        theme: deriveGraphTheme({}),
      },
    );

    assert.deepEqual(result, { kind: "cancel" });
    assert.deepEqual(workingCalls, []);
  });

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
}
