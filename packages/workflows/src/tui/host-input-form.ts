import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { PiHostInputFormField, PiHostInputFormFunction } from "../extension/ui-surface.js";
import type { WorkflowInputValues } from "../shared/types.js";
import type { InputsPickerResult } from "./inputs-overlay.js";
import { coerceValues, initialInputText } from "./inputs-picker.js";

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
		initialValue: initialInputText(field, prefilled),
		...(field.description !== undefined ? { description: field.description } : {}),
		...(field.required !== undefined ? { required: field.required } : {}),
		...(field.choices !== undefined ? { choices: [...field.choices] } : {}),
		...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
		...(field.const !== undefined ? { const: field.const } : {}),
		...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
		...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
		...(field.exclusiveMinimum !== undefined ? { exclusiveMinimum: field.exclusiveMinimum } : {}),
		...(field.exclusiveMaximum !== undefined ? { exclusiveMaximum: field.exclusiveMaximum } : {}),
		...(field.multipleOf !== undefined ? { multipleOf: field.multipleOf } : {}),
		...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
		...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
		...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
		...(field.format !== undefined ? { format: field.format } : {}),
		...(field.schema !== undefined ? { schema: field.schema } : {}),
	}));
	try {
		const raw = await open.call(ui, {
			title: options.workflowName,
			fields,
			heading: "WORKFLOW INPUTS",
			submitLabel: "[ Run workflow ]",
		});
		return raw === undefined ? { kind: "cancel" } : { kind: "run", values: coerceValues(options.fields, raw) };
	} catch {
		return { kind: "unsupported" };
	}
}
