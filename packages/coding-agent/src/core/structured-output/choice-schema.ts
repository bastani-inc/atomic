import type { Static, TSchema } from "typebox";
import type { StructuredChoiceQuestion } from "./types.js";

type ChoiceValue = string | number | boolean | null;

export interface ChoiceSchema<T extends TSchema> {
	readonly questions: Readonly<Record<string, StructuredChoiceQuestion>>;
	readonly decode: (choices: Readonly<Record<string, string>>) => Static<T>;
}

function choiceValues(schema: TSchema): ChoiceValue[] | undefined {
	const value = schema as Record<string, unknown>;
	if (Object.hasOwn(value, "const")) {
		const constant = value.const;
		return constant === null ||
			typeof constant === "string" ||
			typeof constant === "boolean" ||
			(typeof constant === "number" && Number.isFinite(constant))
			? [constant]
			: undefined;
	}
	if (value.type === "boolean") return [true, false];
	if (value.type === "null") return [null];
	if (Array.isArray(value.enum)) {
		const choices = value.enum;
		if (
			choices.every(
				(candidate) =>
					candidate === null ||
					typeof candidate === "string" ||
					typeof candidate === "boolean" ||
					(typeof candidate === "number" && Number.isFinite(candidate)),
			)
		)
			return choices as ChoiceValue[];
	}
	if (Array.isArray(value.anyOf)) {
		const branches = value.anyOf.map((branch) =>
			branch && typeof branch === "object" && !Array.isArray(branch) ? choiceValues(branch as TSchema) : undefined,
		);
		if (branches.every((branch) => branch?.length)) return branches.flat() as ChoiceValue[];
	}
	return undefined;
}

function question(
	id: string,
	schema: TSchema,
): { question: StructuredChoiceQuestion; values: Map<string, ChoiceValue> } | undefined {
	const candidates = choiceValues(schema);
	if (!candidates?.length || candidates.some((candidate) => !String(candidate).trim())) return undefined;
	const values = new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate]));
	if (values.size !== candidates.length) return undefined;
	const label = (schema as Record<string, unknown>).description;
	const description = typeof label === "string" && label.trim() ? label : id;
	return {
		question: {
			instructions: `Choose the exact value for ${description}.`,
			criteria: Object.fromEntries([...values].map(([key, candidate]) => [key, String(candidate)])),
		},
		values,
	};
}

export function compileChoiceSchema<T extends TSchema>(schema: T): ChoiceSchema<T> | undefined {
	const source = schema as Record<string, unknown>;
	if (source.type === "object") {
		const properties = source.properties;
		if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
		const fields = Object.entries(properties);
		const required = source.required;
		if (
			!fields.length ||
			!Array.isArray(required) ||
			required.length !== fields.length ||
			fields.some(([key]) => !required.includes(key))
		)
			return undefined;
		const mapped = fields.map(([key, property]) =>
			property && typeof property === "object" && !Array.isArray(property)
				? ([key, question(key, property as TSchema)] as const)
				: ([key, undefined] as const),
		);
		if (mapped.some(([, choice]) => !choice)) return undefined;
		return {
			questions: Object.fromEntries(mapped.map(([key, choice]) => [key, choice!.question])),
			decode: (choices) =>
				Object.fromEntries(mapped.map(([key, choice]) => [key, choice!.values.get(choices[key])])) as Static<T>,
		};
	}
	const root = question("result", schema);
	if (!root) return undefined;
	return {
		questions: { result: root.question },
		decode: (choices) => root.values.get(choices.result) as Static<T>,
	};
}
