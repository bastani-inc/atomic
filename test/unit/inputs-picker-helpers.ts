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
import assert from "node:assert/strict";
import { openInputsPicker, type InputsPickerResult } from "../../packages/workflows/src/tui/inputs-overlay.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
} from "../../packages/workflows/src/extension/wiring.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

export const KB = makeFakeKeybindings();

export const OVERLAY_FIELDS: WorkflowInputEntry[] = [
  { name: "prompt", type: "string", required: true },
];

export interface MountedInputsPicker {
  readonly component: PiCustomComponent;
  readonly promise: Promise<InputsPickerResult>;
  readonly workingCalls: boolean[];
  readonly customOptions: PiCustomOverlayOptions[];
}

export function mountInputsPicker(): MountedInputsPicker {
  let component: PiCustomComponent | undefined;
  const workingCalls: boolean[] = [];
  const customOptions: PiCustomOverlayOptions[] = [];
  const custom: PiCustomOverlayFunction = (
    factory: PiCustomOverlayFactory,
    options: PiCustomOverlayOptions,
  ) => {
    customOptions.push(options);
    const mounted = factory({ requestRender: () => undefined }, undefined, KB, () => undefined);
    if (mounted instanceof Promise) {
      throw new Error("test seam expects synchronous picker factory");
    }
    component = mounted;
  };
  const promise = openInputsPicker(
    {
      custom,
      setWorkingVisible: (visible) => workingCalls.push(visible),
    },
    {
      workflowName: "ralph",
      fields: OVERLAY_FIELDS,
      prefilled: { prompt: "ready" },
      theme: deriveGraphTheme({}),
    },
  );
  assert.ok(component, "custom factory should mount synchronously in this test seam");
  return { component, promise, workingCalls, customOptions };
}

export const FIELDS: WorkflowInputEntry[] = [
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

