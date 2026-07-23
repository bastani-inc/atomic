import type { WorkflowInputEntry } from "../extension/render-result.js";
import type {
  PiHostInputFormField,
  PiHostInputFormFunction,
} from "../extension/ui-surface.js";
import type { WorkflowInputValues } from "../shared/types.js";
import { coerceValues } from "./inputs-picker.js";
import type { InputsPickerResult } from "./inputs-overlay.js";

export interface HostInputsFormUi {
  hostInputForm?: PiHostInputFormFunction;
}

function supportedType(type: string): PiHostInputFormField["type"] {
  switch (type) {
    case "text":
    case "number":
    case "integer":
    case "boolean":
    case "select":
      return type;
    default:
      return "string";
  }
}

function initialValue(field: WorkflowInputEntry, prefilled: WorkflowInputValues): string {
  if (prefilled[field.name] !== undefined) return String(prefilled[field.name]);
  if (field.default !== undefined) return String(field.default);
  if (field.type === "select" && field.choices && field.choices.length > 0) return field.choices[0]!;
  if (field.type === "boolean") return "false";
  return "";
}

/** Adapt workflow schemas to the host-owned, raw-string form capability. */
export async function openHostInputsForm(
  ui: HostInputsFormUi,
  options: {
    workflowName: string;
    fields: readonly WorkflowInputEntry[];
    prefilled?: WorkflowInputValues;
  },
): Promise<InputsPickerResult | { kind: "unsupported" }> {
  const open = ui.hostInputForm;
  if (typeof open !== "function") return { kind: "unsupported" };
  const prefilled = options.prefilled ?? {};
  const fields: PiHostInputFormField[] = options.fields.map((field) => ({
    name: field.name,
    type: supportedType(field.type),
    initialValue: initialValue(field, prefilled),
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.choices !== undefined ? { choices: [...field.choices] } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
  }));
  try {
    const raw = await open.call(ui, { title: options.workflowName, fields, heading: "WORKFLOW INPUTS", submitLabel: "[ Run workflow ]" });
    return raw === undefined ? { kind: "cancel" } : { kind: "run", values: coerceValues(options.fields, raw) };
  } catch {
    return { kind: "unsupported" };
  }
}
