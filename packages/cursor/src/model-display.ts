export interface CursorParameterOptionMetadata {
	readonly value: string;
	readonly label?: string;
	readonly wireField3?: boolean;
}

export interface CursorParameterDefinitionMetadata {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly type: "boolean" | "enum" | "unknown";
	readonly options: readonly CursorParameterOptionMetadata[];
	readonly wireField5?: boolean;
}

export interface CursorDisplayParameter {
	readonly id: string;
	readonly value: string;
}

interface CursorGroupPresentationInput {
	readonly sourceModelId: string;
	readonly displayName: string;
	readonly isMaxMode: boolean;
	readonly parameters: readonly CursorDisplayParameter[];
	readonly effortParameter?: CursorDisplayParameter;
	readonly definitions?: readonly CursorParameterDefinitionMetadata[];
}

export interface CursorGroupPresentation {
	readonly desiredId: string;
	readonly name: string;
	readonly signature: string;
}

export function cursorGroupPresentation(input: CursorGroupPresentationInput): CursorGroupPresentation {
	const semantic = input.parameters.filter((parameter) => parameter !== input.effortParameter);
	const definitions = new Map(input.definitions?.map((definition) => [definition.id, definition]));
	const valueQualifiers: string[] = [];
	const booleanQualifiers: string[] = [];
	const idQualifiers: string[] = [];
	const booleanIdQualifiers: string[] = [];

	for (const parameter of semantic) {
		const definition = definitions.get(parameter.id);
		if (parameter.id === "thinking" || parameter.id === "fast") {
			if (parameter.value !== "true") continue;
			const label = optionLabel(definition, parameter.value) ?? definition?.displayName ?? titleCase(parameter.id);
			booleanQualifiers.push(label);
			booleanIdQualifiers.push(encodeIdPart(parameter.id));
			continue;
		}
		const option = optionLabel(definition, parameter.value);
		if (parameter.id === "context") {
			valueQualifiers.push(option ?? contextLabel(parameter.value));
			idQualifiers.push(encodeIdPart(parameter.value));
			continue;
		}
		const parameterLabel = definition?.displayName ?? titleCase(parameter.id);
		valueQualifiers.push(`${parameterLabel}: ${option ?? titleCase(parameter.value)}`);
		idQualifiers.push(`${encodeIdPart(parameter.id)}-${encodeIdPart(parameter.value)}`);
	}
	if (input.isMaxMode) {
		valueQualifiers.push("Max");
		idQualifiers.push("max");
	}
	idQualifiers.push(...booleanIdQualifiers);
	valueQualifiers.push(...booleanQualifiers);
	const desiredId = [input.sourceModelId, ...idQualifiers].join("-");
	const qualifiers = valueQualifiers.length > 0 ? ` (${valueQualifiers.join(", ")})` : "";
	return {
		desiredId,
		name: `${input.displayName}${qualifiers}`,
		signature: JSON.stringify([input.sourceModelId, input.isMaxMode, semantic]),
	};
}

export function allocateCollisionSafeIds(
	presentations: readonly CursorGroupPresentation[],
): readonly string[] {
	const counts = new Map<string, number>();
	for (const presentation of presentations) {
		counts.set(presentation.desiredId, (counts.get(presentation.desiredId) ?? 0) + 1);
	}
	return presentations.map((presentation) => counts.get(presentation.desiredId) === 1
		? presentation.desiredId
		: `${presentation.desiredId}-${stableHash(presentation.signature)}`);
}

function optionLabel(
	definition: CursorParameterDefinitionMetadata | undefined,
	value: string,
): string | undefined {
	return definition?.options.find((option) => option.value === value)?.label;
}

function contextLabel(value: string): string {
	return /^\d+(?:\.\d+)?[km]$/iu.test(value) ? value.toUpperCase() : titleCase(value);
}

function encodeIdPart(value: string): string {
	let encoded = "";
	for (const byte of new TextEncoder().encode(value)) {
		const isAsciiAlphaNumeric = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
		encoded += isAsciiAlphaNumeric ? String.fromCharCode(byte).toLowerCase() : `_${byte.toString(16).padStart(2, "0")}`;
	}
	return encoded || "value";
}

function titleCase(value: string): string {
	return value
		.split(/[-_/]+/u)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
