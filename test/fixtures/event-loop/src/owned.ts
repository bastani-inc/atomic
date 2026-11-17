import { readdirSync } from "node:fs";

export function listOwnedArea(): string[] {
	return readdirSync(".");
}
