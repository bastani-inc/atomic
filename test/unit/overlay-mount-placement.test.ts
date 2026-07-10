/**
 * Unit tests for workflow picker overlay mount placement.
 *
 * These exercise the wrappers in `src/tui/session-overlays.ts` and
 * `src/tui/inputs-overlay.ts` to verify they mount via pi's
 * `ctx.ui.custom(factory, { overlay: false })` — i.e. the **inline**
 * mount mode where the host's `ExtensionUiController.custom` REPLACES
 * the editor component with the mounted picker. Inline placement
 * eliminates the bottom-anchored chrome regression captured in
 * `ui/workflows/Screenshot 2026-05-13 at 1.09.32 AM.png` without any
 * overlay padding tricks — the host owns geometry.
 *
 * cross-ref:
 *  - src/tui/session-overlays.ts
 *  - src/tui/inputs-overlay.ts
 *  - pi packages/coding-agent/src/modes/controllers/extension-ui-controller.ts
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  openKillConfirm,
  openSessionPicker,
  type ConfirmUiSurface,
  type SessionPickerResult,
  type UiSurface,
} from "../../packages/workflows/src/tui/session-overlays.ts";
import {
  openWorkflowResumeSelector,
  type WorkflowResumeSelectorUiSurface,
} from "../../packages/workflows/src/tui/workflow-resume-selector.ts";
import {
  openInputsPicker,
  type InputsPickerResult,
  type InputsUiSurface,
} from "../../packages/workflows/src/tui/inputs-overlay.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayOptions,
} from "../../packages/workflows/src/extension/wiring.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";

interface MountCapture {
  factory: PiCustomOverlayFactory;
  options: PiCustomOverlayOptions;
  component: PiCustomComponent;
}

/** Build a `pi.ui.custom`-shaped mock that invokes the factory synchronously. */
function buildCustomSurface(): {
  surface: (ConfirmUiSurface & InputsUiSurface & WorkflowResumeSelectorUiSurface) & {
    setWorkingVisible: (visible: boolean) => void;
  };
  calls: MountCapture[];
  workingCalls: boolean[];
} {
  const calls: MountCapture[] = [];
  const workingCalls: boolean[] = [];
  const surface = {
    setWorkingVisible: (visible: boolean) => { workingCalls.push(visible); },
    custom: (factoryArg: PiCustomOverlayFactory, options: PiCustomOverlayOptions) => {
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => undefined,
      };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) {
        throw new Error("test factory should be sync");
      }
      calls.push({ factory: factoryArg, options, component });
      return undefined;
    },
  };
  return { surface, calls, workingCalls };
}

function makeRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000000",
    name: over.name ?? "demo",
    inputs: over.inputs ?? {},
    status: over.status ?? "running",
    stages: over.stages ?? [],
    startedAt: over.startedAt ?? Date.now(),
    endedAt: over.endedAt,
    durationMs: over.durationMs,
    result: over.result,
    error: over.error,
  };
}

// ── Session picker ─────────────────────────────────────────────────────────

test("openSessionPicker mounts via ctx.ui.custom with overlay:false (inline mode)", () => {
  const { surface, calls } = buildCustomSurface();
  const store = createStore();
  store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
  const theme = deriveGraphTheme({});

  void openSessionPicker(surface as UiSurface, store, theme, "connect");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.options.overlay,
    false,
    "session picker must mount inline; pi replaces the editor with the picker",
  );
  // No `overlayOptions` / `onHandle` should leak — inline mode is host-managed.
  assert.equal(calls[0]!.options.overlayOptions, undefined);
  assert.equal(calls[0]!.options.onHandle, undefined);
});

test("openSessionPicker renders at the picker's natural inline height", () => {
  const { surface, calls } = buildCustomSurface();
  const store = createStore();
  store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
  const theme = deriveGraphTheme({});

  void openSessionPicker(surface as UiSurface, store, theme, "connect");

  const lines = calls[0]!.component.render(80);
  // Natural picker — header / blank / filter / blank / section / row /
  // blank / bottom border / hints. Should never balloon into fullscreen.
  assert.ok(lines.length > 0, "expected non-empty render");
  assert.ok(lines.length < 30, `unexpected line count ${lines.length} — picker should stay inline`);
  // Last line is the keyboard-hint row, not an empty pad. Inline mode
  // does no top-anchor padding.
  assert.notEqual(lines[lines.length - 1], "");
  // First line must be the picker's header border, not a blank pad.
  assert.notEqual(lines[0], "");
});

test("openSessionPicker resolves close when ui.custom is absent (no mount)", async () => {
  const surface: UiSurface = {};
  const store = createStore();
  const theme = deriveGraphTheme({});
  const result: SessionPickerResult = await openSessionPicker(surface, store, theme, "connect");
  assert.deepEqual(result, { kind: "close" });
});

test("openSessionPicker leaves Working visibility to the host on connect", async () => {
  const { surface, calls, workingCalls } = buildCustomSurface();
  const store = createStore();
  store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
  const theme = deriveGraphTheme({});

  const pending = openSessionPicker(surface as UiSurface, store, theme, "connect");

  assert.deepEqual(workingCalls, []);
  calls[0]!.component.handleInput?.("\r");
  const result = await pending;
  assert.deepEqual(result, { kind: "connect", runId: "run-1" });
  assert.deepEqual(workingCalls, []);
});

test("openSessionPicker leaves Working visibility to the host on close and dispose", async () => {
  const closeSurface = buildCustomSurface();
  const store = createStore();
  store.recordRunStart(makeRun({ id: "run-1", name: "alpha" }));
  const theme = deriveGraphTheme({});

  const closePending = openSessionPicker(closeSurface.surface as UiSurface, store, theme, "connect");
  closeSurface.calls[0]!.component.handleInput?.("\x1b");
  assert.deepEqual(await closePending, { kind: "close" });
  assert.deepEqual(closeSurface.workingCalls, []);

  const disposeSurface = buildCustomSurface();
  const disposePending = openSessionPicker(disposeSurface.surface as UiSurface, store, theme, "connect");
  disposeSurface.calls[0]!.component.dispose?.();
  assert.deepEqual(await disposePending, { kind: "close" });
  assert.deepEqual(disposeSurface.workingCalls, []);
});

test("openSessionPicker leaves Working visibility to the host when custom mount fails", async () => {
  const workingCalls: boolean[] = [];
  const surface = {
    setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
    custom: () => {
      throw new Error("cannot mount picker");
    },
  };
  const result = await openSessionPicker(surface, createStore(), deriveGraphTheme({}), "connect");
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(workingCalls, []);
});

test("openSessionPicker does not touch working visibility when ui.custom is absent", async () => {
  const workingCalls: boolean[] = [];
  const surface = { setWorkingVisible: (visible: boolean) => workingCalls.push(visible) };
  const result = await openSessionPicker(surface as UiSurface, createStore(), deriveGraphTheme({}), "connect");
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(workingCalls, []);
});

test("openWorkflowResumeSelector leaves Working visibility to the host on dispose", async () => {
  const { surface, calls, workingCalls } = buildCustomSurface();
  const pending = openWorkflowResumeSelector(surface, [makeRun({ id: "run-1", name: "alpha" })], []);

  assert.deepEqual(workingCalls, []);
  calls[0]!.component.dispose?.();
  const result = await pending;
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(workingCalls, []);
});

test("openWorkflowResumeSelector leaves Working visibility to the host when custom mount fails", async () => {
  const workingCalls: boolean[] = [];
  const surface = {
    setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
    custom: () => {
      throw new Error("cannot mount resume selector");
    },
  };
  const result = await openWorkflowResumeSelector(surface as WorkflowResumeSelectorUiSurface, [makeRun({ id: "run-1" })], []);
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(workingCalls, []);
});

test("openKillConfirm leaves Working visibility to the host on confirm", async () => {
  const { surface, calls, workingCalls } = buildCustomSurface();
  const pending = openKillConfirm(surface, makeRun({ id: "run-1", name: "alpha" }), deriveGraphTheme({}));

  assert.deepEqual(workingCalls, []);
  calls[0]!.component.handleInput?.("y");
  assert.equal(await pending, true);
  assert.deepEqual(workingCalls, []);
});

test("openKillConfirm leaves Working visibility to the host on cancel, dispose, and custom mount failure", async () => {
  const cancelSurface = buildCustomSurface();
  const cancelPending = openKillConfirm(cancelSurface.surface, makeRun(), deriveGraphTheme({}));
  cancelSurface.calls[0]!.component.handleInput?.("\x1b");
  assert.equal(await cancelPending, false);
  assert.deepEqual(cancelSurface.workingCalls, []);

  const disposeSurface = buildCustomSurface();
  const disposePending = openKillConfirm(disposeSurface.surface, makeRun(), deriveGraphTheme({}));
  disposeSurface.calls[0]!.component.dispose?.();
  assert.equal(await disposePending, false);
  assert.deepEqual(disposeSurface.workingCalls, []);

  const mountFailureCalls: boolean[] = [];
  const failingSurface = {
    setWorkingVisible: (visible: boolean) => mountFailureCalls.push(visible),
    custom: () => { throw new Error("cannot mount confirm"); },
  };
  assert.equal(await openKillConfirm(failingSurface as ConfirmUiSurface, makeRun(), deriveGraphTheme({})), false);
  assert.deepEqual(mountFailureCalls, []);
});

test("openKillConfirm leaves Working visibility to the host around fallback confirm dialogs", async () => {
  const workingCalls: boolean[] = [];
  const surface = {
    setWorkingVisible: (visible: boolean) => workingCalls.push(visible),
    confirm: async () => true,
  };

  assert.equal(await openKillConfirm(surface as ConfirmUiSurface, makeRun(), deriveGraphTheme({})), true);
  assert.deepEqual(workingCalls, []);
});

// ── Inputs picker ──────────────────────────────────────────────────────────

const SAMPLE_FIELDS: WorkflowInputEntry[] = [
  { name: "prompt", type: "text", required: true, description: "task to do" },
];

test("openInputsPicker mounts via ctx.ui.custom with overlay:false (inline mode)", () => {
  const { surface, calls } = buildCustomSurface();
  const theme = deriveGraphTheme({});

  void openInputsPicker(surface as InputsUiSurface, {
    workflowName: "demo",
    fields: SAMPLE_FIELDS,
    theme,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.options.overlay,
    false,
    "inputs picker must mount inline; pi replaces the editor with the picker",
  );
  assert.equal(calls[0]!.options.overlayOptions, undefined);
  // Dispose to clean up the cursor-blink interval.
  calls[0]!.component.dispose?.();
});

test("openInputsPicker renders at the form's natural inline height", () => {
  const { surface, calls } = buildCustomSurface();
  const theme = deriveGraphTheme({});

  void openInputsPicker(surface as InputsUiSurface, {
    workflowName: "demo",
    fields: SAMPLE_FIELDS,
    theme,
  });

  const lines = calls[0]!.component.render(80);
  assert.ok(lines.length > 0 && lines.length < 30, `unexpected line count ${lines.length}`);
  // Footer hint row is the last natural line — no trailing pad.
  assert.notEqual(lines[lines.length - 1], "");
  calls[0]!.component.dispose?.();
});

test("openInputsPicker resolves cancel when ui.custom is absent (no mount)", async () => {
  const surface: InputsUiSurface = {};
  const theme = deriveGraphTheme({});
  const result: InputsPickerResult = await openInputsPicker(surface, {
    workflowName: "demo",
    fields: SAMPLE_FIELDS,
    theme,
  });
  assert.deepEqual(result, { kind: "cancel" });
});

test("openInputsPicker leaves Working visibility to the host on dispose", async () => {
  const { surface, calls, workingCalls } = buildCustomSurface();
  const theme = deriveGraphTheme({});

  const pending = openInputsPicker(surface as InputsUiSurface, {
    workflowName: "demo",
    fields: SAMPLE_FIELDS,
    theme,
  });

  assert.deepEqual(workingCalls, []);
  calls[0]!.component.dispose?.();
  const result = await pending;
  assert.deepEqual(result, { kind: "cancel" });
  assert.deepEqual(workingCalls, []);
});

test("openInputsPicker short-circuits run when fields are empty (no mount)", async () => {
  const { surface, calls } = buildCustomSurface();
  const theme = deriveGraphTheme({});
  const result: InputsPickerResult = await openInputsPicker(surface as InputsUiSurface, {
    workflowName: "demo",
    fields: [],
    theme,
  });
  assert.equal(result.kind, "run");
  assert.equal(calls.length, 0, "no overlay should mount when there are no fields to collect");
});
