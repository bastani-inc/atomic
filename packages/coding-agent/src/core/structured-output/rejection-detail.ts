import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Errors } from "typebox/value";

export const SCHEMA_MISMATCH_PREFIX = "Invalid structured output: response does not match the decision schema.";
export const UNPARSEABLE_ARGUMENTS_PREFIX = "Invalid structured output: tool call arguments were not valid JSON.";

const MAX_LISTED_ERRORS = 5;
const MAX_LINE_LENGTH = 160;
const MAX_LISTED_LITERALS = 6;
const MAX_PARSER_EXCERPT_LENGTH = 200;

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function jsonKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return value === undefined ? "undefined" : typeof value;
}

function valueAt(root: unknown, pointer: string): unknown {
	let current = root;
	for (const encoded of pointer.split("/").slice(1)) {
		const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function childPath(parent: string, key: string): string {
	return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isUnion(error: TLocalizedValidationError): boolean {
	return error.keyword === "anyOf" || error.keyword === "oneOf";
}

function isExpectation(error: TLocalizedValidationError): boolean {
	return error.keyword === "const" || error.keyword === "type";
}

function expectation(error: TLocalizedValidationError): string {
	const { params } = error;
	if ("allowedValue" in params) return truncate(JSON.stringify(params.allowedValue) ?? "", 40);
	return "type" in params ? [params.type].flat().join(" or ") : "";
}

type Finding = { readonly line: string } | { readonly path: string; readonly expected: string };

function describeError(
	error: TLocalizedValidationError,
	alternatives: readonly TLocalizedValidationError[],
): Finding[] {
	const path = error.instancePath;
	const label = path || "/";
	switch (error.keyword) {
		case "required":
			return strings(error.params.requiredProperties).map((key) => ({ line: `${childPath(path, key)}: required` }));
		case "additionalProperties":
			return strings(error.params.additionalProperties).map((key) => ({
				line: `${childPath(path, key)}: not allowed`,
			}));
		case "boolean":
			return [{ line: `${label}: not allowed` }];
		case "type":
		case "const":
			return [{ path, expected: expectation(error) }];
		case "anyOf":
		case "oneOf": {
			const sameLevel = alternatives.filter((alternative) => alternative.instancePath === path);
			if (sameLevel.length === alternatives.length && sameLevel.every(isExpectation))
				return sameLevel.map((alternative) => ({ path, expected: expectation(alternative) }));
			return [{ path, expected: "a value matching one of the allowed schemas" }];
		}
		default:
			return [{ line: `${label}: ${error.message}` }];
	}
}

/** One line per failing path with the expected shape. Never includes any part of the rejected value. */
export function describeSchemaErrors(schema: TSchema, value: unknown): string[] {
	const errors = Errors(schema, value);
	const unions = errors.filter(isUnion);
	const within = (error: TLocalizedValidationError, union: TLocalizedValidationError): boolean =>
		error !== union &&
		(error.instancePath === union.instancePath || error.instancePath.startsWith(`${union.instancePath}/`));
	const expectations = new Map<string, string[]>();
	const lines = new Map<string, string>();
	for (const error of errors) {
		if (unions.some((union) => within(error, union))) continue;
		const alternatives = isUnion(error) ? errors.filter((candidate) => within(candidate, error)) : [];
		for (const finding of describeError(error, alternatives)) {
			if ("line" in finding) lines.set(finding.line, finding.line);
			else {
				const listed = expectations.get(finding.path) ?? [];
				if (!listed.includes(finding.expected)) listed.push(finding.expected);
				expectations.set(finding.path, listed);
				lines.set(`expected:${finding.path}`, finding.path);
			}
		}
	}
	return [...lines].map(([key, line]) => {
		if (!key.startsWith("expected:")) return truncate(line, MAX_LINE_LENGTH);
		const listed = expectations.get(line) ?? [];
		const shown = listed.slice(0, MAX_LISTED_LITERALS).join(" or ");
		const got = jsonKind(valueAt(value, line));
		return truncate(
			`${line || "/"}: expected ${shown}${listed.length > MAX_LISTED_LITERALS ? " or …" : ""}, got ${got}`,
			MAX_LINE_LENGTH,
		);
	});
}

export function schemaMismatchMessage(lines: readonly string[]): string {
	if (lines.length === 0)
		return `${SCHEMA_MISMATCH_PREFIX} The decision failed validation against the original candidates and constraints.`;
	const omitted = lines.length - MAX_LISTED_ERRORS;
	return `${SCHEMA_MISMATCH_PREFIX} Failing paths: ${lines.slice(0, MAX_LISTED_ERRORS).join("; ")}${omitted > 0 ? `; and ${omitted} more` : ""}.`;
}

/** pi-ai appends the raw payload after a blank line; only the parser's first line is safe to surface. */
export function unparseableArgumentsMessage(argumentsError: string): string {
	const excerpt = truncate(argumentsError.split("\n", 1)[0].trim(), MAX_PARSER_EXCERPT_LENGTH);
	if (!excerpt) return UNPARSEABLE_ARGUMENTS_PREFIX;
	return `${UNPARSEABLE_ARGUMENTS_PREFIX} Parser stopped at: ${excerpt}${/[.…]$/.test(excerpt) ? "" : "."}`;
}
