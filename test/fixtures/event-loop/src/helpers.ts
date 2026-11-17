import { readFileSync } from "node:fs";

export function readHelperOnlyOwnedCodeCalls(): string {
	return readFileSync("helper.txt", "utf8");
}
