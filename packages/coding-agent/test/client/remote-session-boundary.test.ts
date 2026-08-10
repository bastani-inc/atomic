import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const CLIENT_ROOT = join(SRC_ROOT, "client");
const ENGINE_ROOT = join(SRC_ROOT, "modes", "interactive-engine");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && path.endsWith(".ts") ? [path] : [];
	});
}

function importedSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const imports = /\bfrom\s+["']([^"']+)["']|\bimport\s*(?:\(\s*)?["']([^"']+)["']/g;
	for (const match of source.matchAll(imports)) {
		const specifier = match[1] ?? match[2];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

describe("RemoteSession and isolated-engine boundary", () => {
	test("keeps the protocol client and interactive engine import graphs separate", () => {
		for (const path of sourceFiles(CLIENT_ROOT)) {
			const specifiers = importedSpecifiers(readFileSync(path, "utf8"));
			expect(specifiers, relative(SRC_ROOT, path)).not.toContainEqual(
				expect.stringMatching(/(?:^|\/)interactive-engine(?:\/|$)/),
			);
			expect(specifiers, relative(SRC_ROOT, path)).not.toContainEqual(expect.stringMatching(/(?:^|\/)core(?:\/|$)/));
		}

		for (const path of sourceFiles(ENGINE_ROOT)) {
			const specifiers = importedSpecifiers(readFileSync(path, "utf8"));
			expect(specifiers, relative(SRC_ROOT, path)).not.toContainEqual(
				expect.stringMatching(/(?:^|\/)client(?:\/|$)/),
			);
		}
	});
});
