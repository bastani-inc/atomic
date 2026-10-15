import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { test } from "vitest";
import { readText } from "../helpers/runtime.js";

test("session storage runtime modules remain portable", async () => {
	const pending = [
		new URL("../../packages/coding-agent/src/core/storage/session/memory-session-store.ts", import.meta.url),
		new URL("../../packages/coding-agent/src/core/storage/session/sql-session-store.ts", import.meta.url),
		new URL("../../packages/coding-agent/src/core/storage/session/types.ts", import.meta.url),
	];
	const checked = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (checked.has(file.href)) continue;
		checked.add(file.href);
		const source = await readText(fileURLToPath(file));
		assert.doesNotMatch(
			source,
			/(?:from\s*|import\s*(?:\(\s*)?)["'](?:node:|fs(?:\/|["'])|path["']|bun:)/,
			file.href,
		);
		const parsed = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const statement of parsed.program.body) {
			if (statement.type === "ImportDeclaration") {
				if (statement.importKind === "type") continue;
			} else if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
				if (statement.exportKind === "type") continue;
			} else continue;
			const specifier = statement.source;
			if (specifier?.value.startsWith(".")) {
				pending.push(new URL(specifier.value.replace(/\.js$/, ".ts"), file));
			}
		}
	}
});
