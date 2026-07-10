// @ts-nocheck
/**
 * Unit tests for the Option-C inline workflow input form.
 *
 *   - inline-form-store: state seeding + lifecycle (createForm, finalize)
 *   - inline-form-card:  renders live + frozen views; routes status text
 *   - inline-form-overlay: emits sendMessage, mounts the editor with custom UI,
 *     and resolves when the mounted editor exits
 *
 * The editor side is exercised through its public surface (handleInput /
 * render). The overlay test uses a minimal `pi`/`ctx` mock that records
 * sendMessage + custom UI mounts — same pattern as the existing extension test
 * suite.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  _resetForms,
  clearForms,
  createForm,
  finalizeForm,
  getForm,
  touch,
} from "../../packages/workflows/src/tui/inline-form-store.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import { InlineFormEditor } from "../../packages/workflows/src/tui/inline-form-editor.ts";
import {
  openInlineInputsForm,
  registerInlineFormRenderer,
} from "../../packages/workflows/src/tui/inline-form-overlay.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

export const FIELDS: readonly WorkflowInputEntry[] = [
  { name: "prompt", type: "text", required: true, description: "task" },
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

export function makeState(overrides: Partial<Parameters<typeof createForm>[0]> = {}) {
  _resetForms();
  return createForm({
    formId: "wf-test",
    workflowName: "ralph",
    fields: FIELDS,
    rawText: { prompt: "", iters: "5", focus: "standard", verbose: "false" },
    focusedIdx: 0,
    submitChoiceIdx: 0,
    caret: 0,
    status: "editing",
    ...overrides,
  });
}

// ── store ────────────────────────────────────────────────────────────────





// ── card renderer ────────────────────────────────────────────────────────

export function plain(lines: string[]): string {
  // eslint-disable-next-line no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

export function ansi(lines: string[]): string {
  return lines.join("\n");
}














export function assertLinesWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds ${width} cells: ${visibleWidth(line)} ${JSON.stringify(plain([line]))}`,
    );
  }
}




// ── editor ───────────────────────────────────────────────────────────────

export function makeEditor(state = makeState()) {
  const renders: number[] = [];
  const tui = { requestRender: () => { renders.push(Date.now()); } };
  let exited: { outcome: "submit" | "cancel" } | null = null;
  const editor = new InlineFormEditor(tui, {
    formId: state.formId,
    theme: deriveGraphTheme({}),
    keybindings: makeFakeKeybindings(),
    onExit: (outcome) => { exited = { outcome }; },
  });
  return { editor, state, renders, getExited: () => exited, dispose: () => editor.dispose?.() };
}

















// ── overlay (orchestration) ───────────────────────────────────────────────

interface FakePiSurface {
  sentMessages: Array<{
    customType: string;
    content?: string;
    display?: boolean;
    details?: { formId?: string };
    options?: { excludeFromContext?: boolean };
  }>;
  renderers: Map<string, (payload: unknown) => unknown>;
  pi: {
    sendMessage: (
      m: { customType: string; content?: string; display?: boolean; details?: { formId?: string } },
      options?: { excludeFromContext?: boolean },
    ) => void;
    registerMessageRenderer: (event: string, r: (payload: unknown) => unknown) => void;
  };
}

export function makeFakePi(): FakePiSurface {
  const sentMessages: FakePiSurface["sentMessages"] = [];
  const renderers = new Map<string, (payload: unknown) => unknown>();
  return {
    sentMessages,
    renderers,
    pi: {
      // Capture the options arg so tests can assert context exclusion.
      sendMessage: (m, options) => { sentMessages.push({ ...m, options }); },
      registerMessageRenderer: (event, r) => { renderers.set(event, r); },
    },
  };
}

interface FakeCtx {
  ui: {
    custom: (factory: unknown, options?: unknown) => Promise<unknown>;
    setWorkingVisible?: (visible: boolean) => void;
  };
  installed: Array<{
    factory: unknown;
    options: unknown;
    component: unknown;
    done: (result: unknown) => void;
  }>;
}

export function makeFakeCtx(): FakeCtx {
  const installed: FakeCtx["installed"] = [];
  return {
    installed,
    ui: {
      custom: (factory, options) => new Promise<unknown>((resolve) => {
        const done = (result: unknown): void => resolve(result);
        const component = (factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => unknown)({ requestRender: () => {} }, {}, makeFakeKeybindings(), done);
        installed.push({ factory, options, component, done });
      }),
    },
  };
}












// ── multi-line text field (rich-text prompt box) ──────────────────────────

import { layoutTextField } from "../../packages/workflows/src/tui/inline-form-card.ts";



















// ── paste handling (bracketed + fallback) ────────────────────────────────













// ── injected keybindings: word / line / char editing ──────────────────────











