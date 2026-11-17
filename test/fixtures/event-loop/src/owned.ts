import { readdirSync } from "node:fs";
import { readHelperOnlyOwnedCodeCalls } from "./helpers.ts";

export function listOwnedArea(): string[] {
	return [...readdirSync("."), readHelperOnlyOwnedCodeCalls()];
}
