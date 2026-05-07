/** @jsxImportSource @opentui/react */

import { test, expect, describe, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import {
  WorkflowPicker,
  WorkflowPickerPanel,
  buildEntries,
  buildPickerTheme,
  buildPickerRows,
  buildRows,
  fuzzyMatch,
  isFieldValid,
  type PickerTheme,
  type WorkflowPickerResult,
} from "../../../packages/atomic-sdk/src/components/workflow-picker-panel.tsx";
import type { BrokenWorkflow, WorkflowDefinition, WorkflowInput } from "../../../packages/atomic-sdk/src/types.ts";
import { createRegistry } from "../../../packages/atomic-sdk/src/registry.ts";
import { resolveTheme } from "../../../packages/atomic-sdk/src/runtime/theme.ts";
import {
  renderReact,
  setReactActEnvironment,
  type ReactTestSetup,
} from "./test-helpers.tsx";

// ─── Keyboard input helpers ───────────────────────
//
// OpenTUI's stdin parser holds lone `\x1B` bytes pending, waiting for
// either a follow-up byte or a timeout to disambiguate a bare escape
// key from the start of an escape sequence. In tests that never
// advance the clock, we need to force-flush the parser explicitly.
// The shared React renderer helper wraps input and render cycles in
// React's `act()` so state updates commit before frame capture.

type TestSetup = ReactTestSetup;

function flushPendingInput(setup: TestSetup) {
  // stdinParser is public on CliRenderer (no underscore).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = setup.renderer as any;
  r.stdinParser?.flushTimeout?.(Number.POSITIVE_INFINITY);
  r.drainStdinParser?.();
}

async function press(
  setup: TestSetup,
  action: (input: TestSetup["mockInput"]) => void | Promise<void>,
) {
  await act(async () => {
    await action(setup.mockInput);
    flushPendingInput(setup);
    await Promise.resolve();
  });
  await setup.renderOnce();
}

// ─── Fixtures ─────────────────────────────────────

function makeWorkflow(
  overrides: Partial<Omit<WorkflowDefinition, "__brand" | "run" | "minSDKVersion">> = {},
): WorkflowDefinition {
  return {
    __brand: "WorkflowDefinition" as const,
    name: "wf",
    agent: "claude",
    description: "",
    inputs: [],
    minSDKVersion: null,
    run: async () => {},
    ...overrides,
  } as WorkflowDefinition;
}

const TEST_DARK_BASE = resolveTheme(null);
const TEST_LIGHT_BASE = resolveTheme("light");

const TEST_THEME: PickerTheme = buildPickerTheme(TEST_DARK_BASE);

// A catalog with workflows across agents.
const WORKFLOWS: WorkflowDefinition[] = [
  makeWorkflow({
    name: "ralph",
    agent: "claude",
    description: "run ralph loop",
    inputs: [
      {
        name: "task",
        type: "text",
        required: true,
        description: "the task",
        placeholder: "what to do",
      },
      {
        name: "mode",
        type: "enum",
        required: true,
        values: ["fast", "slow"],
        default: "fast",
      },
      { name: "notes", type: "string", required: false },
    ],
  }),
  makeWorkflow({
    name: "z-deep-research",
    agent: "claude",
    description: "deep research",
    inputs: [
      { name: "question", type: "string", required: true, placeholder: "ask" },
    ],
  }),
  makeWorkflow({
    name: "z-freeform",
    agent: "claude",
    description: "freeform prompt",
    inputs: [],
  }),
];

// ─── Lifecycle ────────────────────────────────────

let testSetup: ReactTestSetup | null = null;

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = null;
});

async function renderPicker(
  opts: {
    workflows?: WorkflowDefinition[];
    onSubmit?: (r: WorkflowPickerResult) => void;
    onCancel?: () => void;
    width?: number;
    height?: number;
    kittyKeyboard?: boolean;
  } = {},
) {
  const onSubmit = opts.onSubmit ?? (() => {});
  const onCancel = opts.onCancel ?? (() => {});
  testSetup = await renderReact(
    <WorkflowPicker
      theme={TEST_THEME}
      agent="claude"
      workflows={opts.workflows ?? WORKFLOWS}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
    {
      width: opts.width ?? 120,
      height: opts.height ?? 40,
      // Kitty mode lets `pressKey("j", { ctrl: true })` emit distinct
      // `ctrl+j` key events instead of being flattened to "\n" which
      // the standard keypress parser reports as return.
      kittyKeyboard: opts.kittyKeyboard ?? false,
    },
  );
  await testSetup.renderOnce();
  return testSetup;
}

// ─── Pure helper unit tests ───────────────────────

describe("fuzzyMatch", () => {
  test("returns 0 for empty query", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });

  test("returns null when no subsequence match", () => {
    expect(fuzzyMatch("xyz", "hello")).toBeNull();
  });

  test("matches contiguous prefix cheaply", () => {
    const score = fuzzyMatch("hel", "hello");
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(20);
  });

  test("penalises gaps between matched characters", () => {
    // "ab" should match both "ab" and "a_____b" but the latter scores higher
    // (higher = worse).
    const tight = fuzzyMatch("ab", "ab")!;
    const loose = fuzzyMatch("ab", "a-----b")!;
    expect(tight).toBeLessThan(loose);
  });

  test("case insensitive", () => {
    expect(fuzzyMatch("ABC", "abcdef")).not.toBeNull();
    expect(fuzzyMatch("abc", "ABCDEF")).not.toBeNull();
  });
});

describe("isFieldValid", () => {
  test("optional field is always valid", () => {
    const f: WorkflowInput = { name: "n", type: "string", required: false };
    expect(isFieldValid(f, "")).toBe(true);
    expect(isFieldValid(f, "  ")).toBe(true);
  });

  test("required string/text invalid when only whitespace", () => {
    const f: WorkflowInput = { name: "n", type: "string", required: true };
    expect(isFieldValid(f, "")).toBe(false);
    expect(isFieldValid(f, "   ")).toBe(false);
    expect(isFieldValid(f, "x")).toBe(true);
  });

  test("required text treats newline-only as invalid", () => {
    const f: WorkflowInput = { name: "n", type: "text", required: true };
    expect(isFieldValid(f, "\n")).toBe(false);
    expect(isFieldValid(f, "content\n")).toBe(true);
  });

  test("required enum invalid when empty string", () => {
    const f: WorkflowInput = {
      name: "mode",
      type: "enum",
      required: true,
      values: ["a", "b"],
    };
    expect(isFieldValid(f, "")).toBe(false);
    // Enum fields don't trim — any non-empty selection is valid.
    expect(isFieldValid(f, "a")).toBe(true);
  });
});

describe("buildEntries", () => {
  test("empty query groups workflows by agent in canonical order", () => {
    const workflows = [
      makeWorkflow({ name: "wf-a", agent: "claude" }),
      makeWorkflow({ name: "wf-b", agent: "copilot" }),
      makeWorkflow({ name: "wf-c", agent: "opencode" }),
    ];
    const entries = buildEntries("", workflows);
    const sections = entries.map((e) => e.section);
    // claude before copilot before opencode.
    expect(sections).toEqual(["claude", "copilot", "opencode"]);
  });

  test("empty query sorts alphabetically within an agent", () => {
    const workflows = [
      makeWorkflow({ name: "zebra", agent: "claude" }),
      makeWorkflow({ name: "alpha", agent: "claude" }),
      makeWorkflow({ name: "mango", agent: "claude" }),
    ];
    const entries = buildEntries("", workflows);
    expect(entries.map((e) => e.workflow.name)).toEqual([
      "alpha",
      "mango",
      "zebra",
    ]);
  });

  test("non-empty query sorts by score regardless of agent", () => {
    const entries = buildEntries("ralph", WORKFLOWS);
    expect(entries.length).toBeGreaterThan(0);
    // "ralph" should match the ralph workflow first.
    expect(entries[0]!.workflow.name).toBe("ralph");
  });

  test("query that matches description only still returns the entry", () => {
    const workflows = [
      makeWorkflow({
        name: "wf-a",
        description: "does unique-marker thing",
      }),
    ];
    const entries = buildEntries("unique-marker", workflows);
    expect(entries).toHaveLength(1);
  });

  test("query with no match returns empty", () => {
    const entries = buildEntries("qqqqqq", WORKFLOWS);
    expect(entries).toHaveLength(0);
  });

  test("name match scored strictly better than description-only match", () => {
    // Two workflows, one matches in name, one matches in description.
    const workflows = [
      makeWorkflow({ name: "abc", description: "irrelevant" }),
      makeWorkflow({ name: "other", description: "abc here" }),
    ];
    const entries = buildEntries("abc", workflows);
    // The name-match should sort first.
    expect(entries[0]!.workflow.name).toBe("abc");
  });
});

describe("buildRows", () => {
  test("empty query inserts section headers for each agent transition", () => {
    const workflows = [
      makeWorkflow({ name: "wf-a", agent: "claude" }),
      makeWorkflow({ name: "wf-b", agent: "copilot" }),
      makeWorkflow({ name: "wf-c", agent: "opencode" }),
    ];
    const entries = buildEntries("", workflows);
    const rows = buildRows(entries, "");
    const sectionRows = rows.filter((r) => r.kind === "section");
    expect(sectionRows).toHaveLength(3);
    expect(sectionRows.map((r) => r.kind === "section" && r.agent)).toEqual([
      "claude",
      "copilot",
      "opencode",
    ]);
  });

  test("non-empty query emits no section rows", () => {
    const entries = buildEntries("ralph", WORKFLOWS);
    const rows = buildRows(entries, "ralph");
    expect(rows.every((r) => r.kind === "entry")).toBe(true);
  });

  test("empty entries yields empty rows", () => {
    expect(buildRows([], "")).toEqual([]);
  });
});

describe("buildPickerTheme", () => {
  test("maps extended picker roles from Mocha palette", () => {
    const theme = buildPickerTheme(TEST_DARK_BASE);
    expect(theme.backgroundPanel).toBe(TEST_DARK_BASE.backgroundPanel);
    expect(theme.backgroundElement).toBe(TEST_DARK_BASE.backgroundElement);
    expect(theme.info).toBe(TEST_DARK_BASE.info);
    expect(theme.mauve).toBe(TEST_DARK_BASE.mauve);
  });

  test("maps extended picker roles from Latte palette", () => {
    const theme = buildPickerTheme(TEST_LIGHT_BASE);
    expect(theme.backgroundPanel).toBe(TEST_LIGHT_BASE.backgroundPanel);
    expect(theme.backgroundElement).toBe(TEST_LIGHT_BASE.backgroundElement);
    expect(theme.info).toBe(TEST_LIGHT_BASE.info);
    expect(theme.mauve).toBe(TEST_LIGHT_BASE.mauve);
  });

  test("forwards base colors into matching theme slots", () => {
    const theme = buildPickerTheme(TEST_DARK_BASE);
    expect(theme.background).toBe(TEST_DARK_BASE.bg);
    expect(theme.surface).toBe(TEST_DARK_BASE.surface);
    expect(theme.text).toBe(TEST_DARK_BASE.text);
    expect(theme.primary).toBe(TEST_DARK_BASE.accent);
  });
});

// ─── React component rendering ────────────────────

describe("WorkflowPicker rendering", () => {
  test("renders header with agent pill and workflow count", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("CLAUDE");
    expect(frame).toContain("workflow");
    // Three workflows in the catalog.
    expect(frame).toContain("3 workflows");
  });

  test("header shows singular when exactly one workflow", async () => {
    const setup = await renderPicker({
      workflows: [makeWorkflow({ name: "solo", agent: "claude" })],
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("1 workflow");
    expect(frame).not.toContain("1 workflows");
  });

  test("renders PICK mode badge initially", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PICK");
  });

  test("renders workflow names in list", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ralph");
    expect(frame).toContain("z-deep-research");
    expect(frame).toContain("z-freeform");
  });

  test("renders agent section label", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("claude");
  });

  test("renders preview for the focused workflow", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    // Focus starts on the first entry which (alphabetically within claude)
    // is "ralph" — its description and arguments should appear in the preview pane.
    expect(frame).toContain("run ralph loop");
    expect(frame).toContain("ARGUMENTS");
  });

  test("renders navigation hints in statusline", async () => {
    const setup = await renderPicker();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("navigate");
    expect(frame).toContain("select");
    expect(frame).toContain("quit");
  });

  test("renders 'no matches' with empty workflow list", async () => {
    const setup = await renderPicker({ workflows: [] });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("no matches");
  });

  test("empty workflow list renders the empty preview hint", async () => {
    const setup = await renderPicker({ workflows: [] });
    const frame = setup.captureCharFrame();
    // EmptyPreview shows the new worker.ts registration hint.
    expect(frame).toContain("createRegistry");
  });
});

// ─── Keyboard: PICK phase ─────────────────────────

describe("WorkflowPicker PICK keyboard", () => {
  test("escape calls onCancel", async () => {
    let cancelled = false;
    const setup = await renderPicker({
      onCancel: () => {
        cancelled = true;
      },
    });
    await press(setup, (i) => i.pressEscape());
    expect(cancelled).toBe(true);
  });

  test("ctrl+c calls onCancel", async () => {
    let cancelled = false;
    const setup = await renderPicker({
      onCancel: () => {
        cancelled = true;
      },
    });
    await press(setup, (i) => i.pressCtrlC());
    expect(cancelled).toBe(true);
  });

  test("arrow down moves focus to next entry", async () => {
    const setup = await renderPicker();
    await press(setup, (i) => i.pressArrow("down"));
    // The focused preview switches from ralph to z-deep-research.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("deep research");
  });

  test("arrow up is clamped at 0", async () => {
    const setup = await renderPicker();
    // Try to move up from the top — should stay at 0 without throwing.
    await press(setup, (i) => i.pressArrow("up"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("run ralph loop");
  });

  test("ctrl+j moves focus down like arrow down", async () => {
    // Kitty keyboard mode is required for the parser to report the raw
    // key as `ctrl+j` instead of collapsing it onto `return` (CR/LF).
    const setup = await renderPicker({ kittyKeyboard: true });
    await press(setup, (i) => i.pressKey("j", { ctrl: true }));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("deep research");
  });

  test("ctrl+k moves focus up like arrow up", async () => {
    const setup = await renderPicker({ kittyKeyboard: true });
    await press(setup, (i) => i.pressArrow("down"));
    await press(setup, (i) => i.pressKey("k", { ctrl: true }));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("run ralph loop");
  });

  test("arrow down clamps at bottom of list", async () => {
    const setup = await renderPicker();
    for (let i = 0; i < 10; i++) {
      await press(setup, (input) => input.pressArrow("down"));
    }
    const frame = setup.captureCharFrame();
    // After over-scrolling, we should sit on the last workflow (z-freeform).
    expect(frame).toContain("freeform prompt");
  });

  test("typing printable characters builds the query", async () => {
    const setup = await renderPicker();
    await press(setup, (i) => i.typeText("ralph"));
    const frame = setup.captureCharFrame();
    // The query should appear in the filter bar.
    expect(frame).toContain("ralph");
    expect(frame).not.toContain("no matches");
  });

  test("typing a query that matches nothing shows no matches", async () => {
    const setup = await renderPicker();
    await press(setup, (i) => i.typeText("qqqq"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("no matches");
    expect(frame).toContain('"qqqq"');
  });

  test("backspace removes last query character", async () => {
    const setup = await renderPicker();
    await press(setup, (i) => i.typeText("qqqq"));
    // Confirm the "no matches" state before backspacing.
    expect(setup.captureCharFrame()).toContain("no matches");
    for (let i = 0; i < 6; i++) {
      await press(setup, (input) => input.pressBackspace());
    }
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("no matches");
    expect(frame).toContain("run ralph loop");
  });

  test("enter transitions to prompt phase", async () => {
    const setup = await renderPicker();
    await press(setup, (i) => i.pressEnter());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PROMPT");
    expect(frame).toContain("INPUTS");
  });

  test("enter with no focused workflow (empty list) is a no-op", async () => {
    const setup = await renderPicker({ workflows: [] });
    await press(setup, (i) => i.pressEnter());
    // Still in PICK phase.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PICK");
  });

});


// ─── Keyboard: PROMPT phase ───────────────────────

async function renderAndEnterPrompt(
  opts: Parameters<typeof renderPicker>[0] = {},
) {
  const setup = await renderPicker(opts);
  await press(setup, (i) => i.pressEnter());
  return setup;
}

describe("WorkflowPicker PROMPT keyboard", () => {
  test("escape returns to pick phase", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.pressEscape());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PICK");
  });

  test("ctrl+c still calls onCancel from prompt phase", async () => {
    let cancelled = false;
    const setup = await renderAndEnterPrompt({
      onCancel: () => {
        cancelled = true;
      },
    });
    await press(setup, (i) => i.pressCtrlC());
    expect(cancelled).toBe(true);
  });

  test("tab cycles focus forward through fields", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.pressTab());
    const frame = setup.captureCharFrame();
    // ralph has 3 inputs; pos indicator should move to "2 / 3".
    expect(frame).toContain("2 / 3");
  });

  test("shift+tab cycles focus backward through fields", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.pressTab({ shift: true }));
    const frame = setup.captureCharFrame();
    // Shift-tab from field 0 wraps to last (field 3 → "3 / 3").
    expect(frame).toContain("3 / 3");
  });

  test("tab is a no-op when there is only one field", async () => {
    const workflows = [
      makeWorkflow({
        name: "one-field",
        agent: "claude",
        inputs: [{ name: "only", type: "string", required: true }],
      }),
    ];
    const setup = await renderAndEnterPrompt({ workflows });
    await press(setup, (i) => i.pressTab());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("1 / 1");
  });

  test("typing in a text field appends characters", async () => {
    const setup = await renderAndEnterPrompt();
    // Field 0 is the "task" text field.
    await press(setup, (i) => i.typeText("hello"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("hello");
  });

  test("bracketed paste in a text field propagates to onSubmit without further keystrokes", async () => {
    // Bracketed pastes bypass useKeyboard, so this regression-pins the
    // textarea's onPaste handler — without it, pasted content never
    // reaches onFieldInput and the submitted payload would be empty.
    let result: WorkflowPickerResult | null = null;
    const setup = await renderAndEnterPrompt({
      onSubmit: (r) => {
        result = r;
      },
    });
    await press(setup, (i) => i.pasteBracketedText("pasted task body"));
    await press(setup, (i) => i.pressKey("d", { ctrl: true }));
    await press(setup, (i) => i.pressKey("y"));
    expect(result).not.toBeNull();
    expect(result!.inputs.task).toContain("pasted task body");
  });

  test("return in a text field inserts a newline", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.typeText("line1"));
    await press(setup, (i) => i.pressEnter());
    await press(setup, (i) => i.typeText("line2"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    // Still on field 1 of 3 (no field advance).
    expect(frame).toContain("1 / 3");
  });

  test("backspace removes last char from a text field", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.typeText("abc"));
    await press(setup, (i) => i.pressBackspace());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ab");
  });

  test("return on string field advances focus", async () => {
    // A workflow with two string fields — return should jump from field 0 to field 1.
    const workflows = [
      makeWorkflow({
        name: "two-strings",
        agent: "claude",
        inputs: [
          { name: "a", type: "string", required: true },
          { name: "b", type: "string", required: true },
        ],
      }),
    ];
    const setup = await renderAndEnterPrompt({ workflows });
    await press(setup, (i) => i.pressEnter());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("2 / 2");
  });

  test("enum field: right arrow cycles value forward", async () => {
    // ralph has an enum "mode" with ["fast","slow"] at index 1.
    const setup = await renderAndEnterPrompt();
    // Advance focus to field idx 1 (the enum).
    await press(setup, (i) => i.pressTab());
    await press(setup, (i) => i.pressArrow("right"));
    // Now the selected enum should have rotated from "fast" → "slow".
    const frame = setup.captureCharFrame();
    expect(frame).toContain("slow");
  });

  test("enum field: left arrow cycles value backward (wraps)", async () => {
    const setup = await renderAndEnterPrompt();
    await press(setup, (i) => i.pressTab());
    await press(setup, (i) => i.pressArrow("left"));
    const frame = setup.captureCharFrame();
    // "fast" → left wraps back to "slow".
    expect(frame).toContain("slow");
  });

  test("enum field with empty values array is a no-op on arrow", async () => {
    const workflows = [
      makeWorkflow({
        name: "empty-enum",
        agent: "claude",
        inputs: [
          { name: "choice", type: "enum", required: false, values: [] },
        ],
      }),
    ];
    const setup = await renderAndEnterPrompt({ workflows });
    await press(setup, (i) => i.pressArrow("right"));
    // Should not crash; frame should still render.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("empty-enum");
  });

  test("ctrl+d with invalid required text field stays in PROMPT mode", async () => {
    const setup = await renderAndEnterPrompt();
    // Nothing has been typed into the required text field — form invalid.
    await press(setup, (i) => i.pressKey("d", { ctrl: true }));
    const frame = setup.captureCharFrame();
    // Still on PROMPT mode, not CONFIRM.
    expect(frame).toContain("PROMPT");
    expect(frame).not.toContain("CONFIRM");
  });

  test("ctrl+d with all required fields filled opens the confirm modal", async () => {
    const setup = await renderAndEnterPrompt();
    // Fill the required text field "task".
    await press(setup, (i) => i.typeText("do something"));
    await press(setup, (i) => i.pressKey("d", { ctrl: true }));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("CONFIRM");
    expect(frame).toContain("submit");
  });

  test("free-form workflow seeds a DEFAULT prompt field", async () => {
    const setup = await renderPicker();
    // Move down past ralph and z-deep-research to z-freeform.
    for (let i = 0; i < 2; i++) {
      await press(setup, (input) => input.pressArrow("down"));
    }
    await press(setup, (i) => i.pressEnter());
    const frame = setup.captureCharFrame();
    // Free-form uses the same INPUTS section label as structured workflows.
    expect(frame).toContain("INPUTS");
    // Default field name is "prompt".
    expect(frame).toContain("prompt");
  });

  test("ctrl+d on free-form workflow with filled prompt opens confirm modal", async () => {
    const setup = await renderPicker();
    // Navigate to the z-freeform workflow (inputs: []).
    for (let i = 0; i < 2; i++) {
      await press(setup, (input) => input.pressArrow("down"));
    }
    await press(setup, (i) => i.pressEnter());
    // Type into the normalized default prompt textarea.
    await press(setup, (i) => i.typeText("build a dashboard"));
    await press(setup, (i) => i.pressKey("d", { ctrl: true }));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("CONFIRM");
    expect(frame).toContain("submit");
  });

  test("short terminal: fields remain navigable via tab and the focused field is visible", async () => {
    // A many-field workflow at a very constrained height (15 rows) —
    // the scrollbox should keep the focused field visible instead of
    // clumping all fields together.
    const manyFields: WorkflowInput[] = [
      { name: "a", type: "string", required: true },
      { name: "b", type: "string", required: false },
      { name: "c", type: "string", required: false },
      { name: "d", type: "string", required: false },
      { name: "e", type: "string", required: false },
    ];
    const workflows = [
      makeWorkflow({ name: "many", agent: "claude", inputs: manyFields }),
    ];
    const setup = await renderAndEnterPrompt({ workflows, height: 15 });
    // Tab through fields — each should remain navigable without crash.
    for (let i = 0; i < 4; i++) {
      await press(setup, (input) => input.pressTab());
    }
    const frame = setup.captureCharFrame();
    // After 4 tabs we should be on the last field (5 / 5).
    expect(frame).toContain("5 / 5");
    // The PROMPT status badge should still be visible.
    expect(frame).toContain("PROMPT");
  });
});

// ─── Keyboard: CONFIRM phase ─────────────────────

async function renderInConfirm(
  opts: Parameters<typeof renderPicker>[0] = {},
) {
  const setup = await renderAndEnterPrompt(opts);
  await press(setup, (i) => i.typeText("task text"));
  await press(setup, (i) => i.pressKey("d", { ctrl: true }));
  return setup;
}

describe("WorkflowPicker CONFIRM keyboard", () => {
  test("y submits with current inputs", async () => {
    let result: WorkflowPickerResult | null = null;
    const setup = await renderInConfirm({
      onSubmit: (r) => {
        result = r;
      },
    });
    await press(setup, (i) => i.pressKey("y"));
    expect(result).not.toBeNull();
    expect(result!.workflow.name).toBe("ralph");
    expect(result!.inputs.task).toContain("task text");
  });

  test("return also submits", async () => {
    let submitted = false;
    const setup = await renderInConfirm({
      onSubmit: () => {
        submitted = true;
      },
    });
    await press(setup, (i) => i.pressEnter());
    expect(submitted).toBe(true);
  });

  test("n cancels the confirm back to prompt", async () => {
    const setup = await renderInConfirm();
    await press(setup, (i) => i.pressKey("n"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PROMPT");
    expect(frame).not.toContain("CONFIRM");
  });

  test("escape cancels the confirm back to prompt", async () => {
    const setup = await renderInConfirm();
    await press(setup, (i) => i.pressEscape());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PROMPT");
  });

  test("unrelated keys in confirm phase are ignored", async () => {
    const setup = await renderInConfirm();
    await press(setup, (i) => i.pressKey("x"));
    const frame = setup.captureCharFrame();
    // Still in CONFIRM.
    expect(frame).toContain("CONFIRM");
  });

  test("ctrl+c in confirm still calls onCancel", async () => {
    let cancelled = false;
    const setup = await renderInConfirm({
      onCancel: () => {
        cancelled = true;
      },
    });
    await press(setup, (i) => i.pressCtrlC());
    expect(cancelled).toBe(true);
  });
});

// ─── Imperative class ────────────────────────────

describe("WorkflowPickerPanel class", () => {
  let panel: WorkflowPickerPanel | null = null;
  let coreSetup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

  afterEach(() => {
    act(() => {
      panel?.destroy();
    });
    panel = null;
    act(() => {
      coreSetup?.renderer.destroy();
    });
    coreSetup = null;
    setReactActEnvironment(false);
  });

  async function createPanel() {
    coreSetup = await createTestRenderer({ width: 120, height: 40 });
    // Match what the React renderer helper does so useEffect-backed subscriptions (like
    // `useKeyboard`) flush synchronously during construction — without
    // this, the keyboard listener isn't attached in time for subsequent
    // mockInput events.
    setReactActEnvironment(true);
    const registry = WORKFLOWS.reduce(
      (r, wf) => r.register(wf),
      createRegistry(),
    );
    act(() => {
      panel = WorkflowPickerPanel.createWithRenderer(coreSetup!.renderer, {
        agent: "claude",
        registry,
      });
    });
    return panel!;
  }

  test("createWithRenderer returns an instance without throwing", async () => {
    const p = await createPanel();
    expect(p).toBeInstanceOf(WorkflowPickerPanel);
  });

  test("createWithRenderer applies the UI background to the renderer", async () => {
    coreSetup = await createTestRenderer({ width: 120, height: 40 });
    const backgroundCapture: {
      value: Parameters<typeof coreSetup.renderer.setBackgroundColor>[0] | null;
    } = { value: null };
    const originalSetBackgroundColor = coreSetup.renderer.setBackgroundColor.bind(coreSetup.renderer);
    coreSetup.renderer.setBackgroundColor = (color) => {
      backgroundCapture.value = color;
      originalSetBackgroundColor(color);
    };

    const registry = WORKFLOWS.reduce(
      (r, wf) => r.register(wf),
      createRegistry(),
    );
    setReactActEnvironment(true);
    act(() => {
      panel = WorkflowPickerPanel.createWithRenderer(coreSetup!.renderer, {
        agent: "claude",
        registry,
      });
    });

    expect(backgroundCapture.value).toBe(TEST_DARK_BASE.bg);
    expect(Reflect.get(coreSetup.renderer, "forceFullRepaintRequested")).toBe(true);
  });

  test("waitForSelection returns a pending promise", async () => {
    const p = await createPanel();
    const promise = p.waitForSelection();
    expect(promise).toBeInstanceOf(Promise);

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    await Bun.sleep(5);
    expect(resolved).toBe(false);
  });

  test("waitForSelection is idempotent — same promise on subsequent calls", async () => {
    const p = await createPanel();
    const a = p.waitForSelection();
    const b = p.waitForSelection();
    expect(a).toBe(b);
  });

  test("destroy resolves a pending selection with null", async () => {
    const p = await createPanel();
    const promise = p.waitForSelection();
    act(() => {
      p.destroy();
    });
    panel = null;
    const result = await promise;
    expect(result).toBeNull();
  });

  test("destroy is idempotent", async () => {
    const p = await createPanel();
    act(() => {
      p.destroy();
    });
    expect(() => {
      act(() => {
        p.destroy();
      });
    }).not.toThrow();
    panel = null;
  });

  test("createWithRenderer with empty registry still mounts", async () => {
    coreSetup = await createTestRenderer({ width: 120, height: 40 });
    setReactActEnvironment(true);
    act(() => {
      panel = WorkflowPickerPanel.createWithRenderer(coreSetup!.renderer, {
        agent: "opencode",
        registry: createRegistry(),
      });
    });
    expect(panel).toBeInstanceOf(WorkflowPickerPanel);
  });

  async function pressOnCore(fn: () => void | Promise<void>) {
    await act(async () => {
      await fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = coreSetup!.renderer as any;
      r.stdinParser?.flushTimeout?.(Number.POSITIVE_INFINITY);
      r.drainStdinParser?.();
      await Promise.resolve();
    });
    await act(async () => {
      await coreSetup!.renderOnce();
    });
  }

  test("handleCancel: esc from PICK resolves selection with null", async () => {
    const p = await createPanel();
    const selection = p.waitForSelection();
    await pressOnCore(() => coreSetup!.mockInput.pressEscape());
    const result = await selection;
    expect(result).toBeNull();
    // Prevent afterEach from double-destroying after handleCancel.
    panel = null;
    act(() => {
      p.destroy();
    });
  });

  test("handleSubmit: driving the full pick→prompt→confirm→y flow resolves with payload", async () => {
    const p = await createPanel();
    const selection = p.waitForSelection();

    // PICK → press enter to lock in ralph.
    await pressOnCore(() => coreSetup!.mockInput.pressEnter());
    // PROMPT → fill the required text field.
    await pressOnCore(() => coreSetup!.mockInput.typeText("via class"));
    // Ctrl-d → open CONFIRM modal.
    await pressOnCore(() =>
      coreSetup!.mockInput.pressKey("d", { ctrl: true }),
    );
    // y → submit.
    await pressOnCore(() => coreSetup!.mockInput.pressKey("y"));

    const result = await selection;
    expect(result).not.toBeNull();
    expect(result!.workflow.name).toBe("ralph");
    expect(result!.inputs.task).toContain("via class");
    panel = null;
    act(() => {
      p.destroy();
    });
  });
});

// ─── Broken workflow fixtures ─────────────────────

function makeBroken(overrides: Partial<BrokenWorkflow> = {}): BrokenWorkflow {
  return {
    alias: "broken-wf",
    origin: "local",
    agents: ["claude"],
    reason: "command not found on PATH",
    source: "/settings.json",
    fix: "install the command",
    ...overrides,
  };
}

function makeBrokenIndex(
  entries: Array<[key: string, broken: BrokenWorkflow]>,
): ReadonlyMap<string, BrokenWorkflow> {
  return new Map(entries);
}

// ─── buildPickerRows unit tests ───────────────────

describe("buildPickerRows", () => {
  test("healthy-only: returns same rows as buildEntries (empty query)", () => {
    const rows = buildPickerRows("", WORKFLOWS);
    expect(rows.every((r) => r.kind === "healthy")).toBe(true);
    expect(rows).toHaveLength(WORKFLOWS.length);
  });

  test("broken-only: returns broken rows with correct alias+agent", () => {
    const broken = makeBroken({ alias: "my-broken", agents: ["claude"] });
    const index = makeBrokenIndex([["claude/my-broken", broken]]);
    const rows = buildPickerRows("", [], index);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("broken");
    if (row.kind === "broken") {
      expect(row.alias).toBe("my-broken");
      expect(row.agent).toBe("claude");
      expect(row.broken).toBe(broken);
    }
  });

  test("mixed: healthy rows appear before broken in same agent group", () => {
    const broken = makeBroken({ alias: "z-broken", agents: ["claude"] });
    const index = makeBrokenIndex([["claude/z-broken", broken]]);
    const rows = buildPickerRows("", WORKFLOWS, index);
    // WORKFLOWS has 3 claude workflows; broken should come after them.
    const claudeRows = rows.filter(
      (r) => (r.kind === "healthy" ? r.wf.agent : r.agent) === "claude",
    );
    const lastHealthyIdx = claudeRows.findLastIndex((r) => r.kind === "healthy");
    const firstBrokenIdx = claudeRows.findIndex((r) => r.kind === "broken");
    expect(lastHealthyIdx).toBeLessThan(firstBrokenIdx);
  });

  test("empty query: broken row count matches brokenIndex size", () => {
    const index = makeBrokenIndex([
      ["claude/broken-a", makeBroken({ alias: "broken-a" })],
      ["copilot/broken-b", makeBroken({ alias: "broken-b", agents: ["copilot"] })],
    ]);
    const rows = buildPickerRows("", WORKFLOWS, index);
    const brokenRows = rows.filter((r) => r.kind === "broken");
    expect(brokenRows).toHaveLength(2);
  });

  test("filter by query matches broken alias", () => {
    const broken = makeBroken({ alias: "unique-broken-alias" });
    const index = makeBrokenIndex([["claude/unique-broken-alias", broken]]);
    const rows = buildPickerRows("unique-broken", [], index);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("broken");
  });

  test("filter: non-matching query excludes broken rows", () => {
    const broken = makeBroken({ alias: "foo-broken" });
    const index = makeBrokenIndex([["claude/foo-broken", broken]]);
    const rows = buildPickerRows("xxxxxxxxx", [], index);
    expect(rows).toHaveLength(0);
  });

  test("malformed key (no slash) is skipped", () => {
    const broken = makeBroken();
    const index = makeBrokenIndex([["noslash", broken]]);
    const rows = buildPickerRows("", [], index);
    expect(rows).toHaveLength(0);
  });
});

// ─── WorkflowPicker rendering: broken rows ────────

async function renderPickerWithBroken(opts: {
  brokenIndex?: ReadonlyMap<string, BrokenWorkflow>;
  workflows?: WorkflowDefinition[];
  onSubmit?: (r: WorkflowPickerResult) => void;
  onCancel?: () => void;
  width?: number;
  height?: number;
}) {
  const onSubmit = opts.onSubmit ?? (() => {});
  const onCancel = opts.onCancel ?? (() => {});
  testSetup = await renderReact(
    <WorkflowPicker
      theme={TEST_THEME}
      agent="claude"
      workflows={opts.workflows ?? WORKFLOWS}
      brokenIndex={opts.brokenIndex}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
    { width: opts.width ?? 120, height: opts.height ?? 40 },
  );
  await testSetup.renderOnce();
  return testSetup;
}

describe("WorkflowPicker broken row rendering", () => {
  test("healthy-only render unchanged (snapshot baseline)", async () => {
    const setup = await renderPickerWithBroken({ brokenIndex: new Map() });
    const frame = setup.captureCharFrame();
    // All three healthy workflows visible, no broken glyph.
    expect(frame).toContain("ralph");
    expect(frame).toContain("z-deep-research");
    expect(frame).toContain("z-freeform");
    expect(frame).not.toContain("✗");
  });

  test("broken row appears in list with ✗ glyph", async () => {
    const index = makeBrokenIndex([
      ["claude/my-broken-wf", makeBroken({ alias: "my-broken-wf" })],
    ]);
    const setup = await renderPickerWithBroken({ brokenIndex: index });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("my-broken-wf");
    expect(frame).toContain("✗");
  });

  test("mixed healthy + broken: both visible, broken count matches", async () => {
    const index = makeBrokenIndex([
      ["claude/broken-one", makeBroken({ alias: "broken-one" })],
      ["claude/broken-two", makeBroken({ alias: "broken-two" })],
    ]);
    const setup = await renderPickerWithBroken({ brokenIndex: index });
    const frame = setup.captureCharFrame();
    // Healthy still visible.
    expect(frame).toContain("ralph");
    // Both broken entries visible.
    expect(frame).toContain("broken-one");
    expect(frame).toContain("broken-two");
  });

  test("broken row focused state: ✗ still shown", async () => {
    const index = makeBrokenIndex([
      ["claude/alpha-broken", makeBroken({ alias: "alpha-broken" })],
    ]);
    // alpha-broken sorts before "ralph" alphabetically so it won't be index 0 in claude group
    // because healthy rows come first; navigate to it.
    const setup = await renderPickerWithBroken({
      workflows: [],
      brokenIndex: index,
    });
    // With no healthy rows, broken-row is at index 0 (already focused).
    const frame = setup.captureCharFrame();
    expect(frame).toContain("alpha-broken");
    expect(frame).toContain("✗");
  });

  test("focused broken row shows BrokenPreview in right pane", async () => {
    const broken = makeBroken({
      alias: "bad-wf",
      reason: "spawn failed: ENOENT",
      source: "/home/user/.config/atomic/settings.json",
      fix: "install the command or fix path",
    });
    const index = makeBrokenIndex([["claude/bad-wf", broken]]);
    const setup = await renderPickerWithBroken({
      workflows: [],
      brokenIndex: index,
    });
    const frame = setup.captureCharFrame();
    // Preview pane shows title + ✗ + reason.
    expect(frame).toContain("bad-wf");
    expect(frame).toContain("✗ Failed to load");
    expect(frame).toContain("spawn failed: ENOENT");
    expect(frame).toContain("fix");
    expect(frame).toContain("install the command or fix path");
  });

  test("enter on broken: dispatch handler NOT called", async () => {
    let submitCalled = false;
    const index = makeBrokenIndex([
      ["claude/bad-wf", makeBroken({ alias: "bad-wf" })],
    ]);
    const setup = await renderPickerWithBroken({
      workflows: [],
      brokenIndex: index,
      onSubmit: () => { submitCalled = true; },
    });
    // Navigate to broken row (already first since no healthy rows).
    await press(setup, (i) => i.pressEnter());
    expect(submitCalled).toBe(false);
  });

  test("enter on broken: statusline flashes 'cannot run' message with alias", async () => {
    const index = makeBrokenIndex([
      ["claude/bad-wf", makeBroken({ alias: "bad-wf" })],
    ]);
    const setup = await renderPickerWithBroken({
      workflows: [],
      brokenIndex: index,
    });
    await press(setup, (i) => i.pressEnter());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("cannot run");
    expect(frame).toContain("bad-wf");
    expect(frame).toContain("failed to load");
  });

  test("filter '/' matches broken alias — broken row stays visible", async () => {
    const index = makeBrokenIndex([
      ["claude/unique-broken", makeBroken({ alias: "unique-broken" })],
    ]);
    const setup = await renderPickerWithBroken({
      brokenIndex: index,
    });
    await press(setup, (i) => i.typeText("unique-broken"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("unique-broken");
  });

  test("filter query that only matches broken shows broken + no healthy", async () => {
    const index = makeBrokenIndex([
      ["claude/zzz-only-broken", makeBroken({ alias: "zzz-only-broken" })],
    ]);
    const setup = await renderPickerWithBroken({ brokenIndex: index });
    await press(setup, (i) => i.typeText("zzz-only-broken"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("zzz-only-broken");
    // Healthy workflows not shown.
    expect(frame).not.toContain("ralph");
  });

  test("enter on healthy workflow still works when brokenIndex present", async () => {
    const index = makeBrokenIndex([
      ["claude/broken-extra", makeBroken({ alias: "broken-extra" })],
    ]);
    const setup = await renderPickerWithBroken({ brokenIndex: index });
    // First row is "ralph" (healthy, alphabetically first in claude group).
    await press(setup, (i) => i.pressEnter());
    const frame = setup.captureCharFrame();
    // Transitions to PROMPT phase.
    expect(frame).toContain("PROMPT");
    expect(frame).toContain("INPUTS");
  });

  test("three-state snapshot: healthy + broken + healthy-selected combo", async () => {
    // RFC §8.3 three-state lock: render with mixed list, verify all three
    // state elements present simultaneously.
    const index = makeBrokenIndex([
      ["claude/my-broken", makeBroken({ alias: "my-broken" })],
    ]);
    const setup = await renderPickerWithBroken({ brokenIndex: index });

    // Initial state: first entry focused (ralph, healthy), broken row visible.
    const frameInitial = setup.captureCharFrame();
    expect(frameInitial).toContain("ralph");          // healthy focused
    expect(frameInitial).toContain("my-broken");      // broken visible
    expect(frameInitial).toContain("run ralph loop"); // healthy preview

    // Navigate to broken entry (after all healthy rows).
    // WORKFLOWS has 3 entries; broken is at index 3.
    for (let i = 0; i < 3; i++) {
      await press(setup, (input) => input.pressArrow("down"));
    }
    const frameBroken = setup.captureCharFrame();
    expect(frameBroken).toContain("my-broken");       // broken focused
    expect(frameBroken).toContain("✗ Failed to load"); // broken preview
    expect(frameBroken).toContain("ralph");            // healthy still in list

    // Navigate back to a healthy row.
    for (let i = 0; i < 3; i++) {
      await press(setup, (input) => input.pressArrow("up"));
    }
    const frameBack = setup.captureCharFrame();
    expect(frameBack).toContain("run ralph loop");    // healthy preview restored
    expect(frameBack).not.toContain("✗ Failed to load");
  });
});
