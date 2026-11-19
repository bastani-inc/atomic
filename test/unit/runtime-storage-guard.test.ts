import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { test } from "vitest";

// Monitor the platform boundary as well as running real writers with an isolated temp directory.
// A new feature should not need a new exception to choose where to write its scratch.
const roots = [
	"coding-agent/src",
	"subagents/src",
	"workflows/src",
	"workflows/builtin",
	"intercom/broker",
	"web-access",
	"tui/src",
];
const exceptions = new Set([
	"coding-agent/src/core/tools/session-temp-dir.ts", // private fallback and explicit SDK TMPDIR
	"intercom/broker/paths.ts", // bounded Unix socket paths
	"subagents/src/shared/types-runtime.ts", // path of an obsolete tree, read only for migration cleanup
]);

test("runtime writers cannot independently select the shared system temp directory", async () => {
	const packages = fileURLToPath(new URL("../../packages/", import.meta.url));
	const violations: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!["node_modules", "test", "dist", "skills"].includes(entry.name)) await visit(file);
				continue;
			}
			if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
			const name = relative(packages, file).split(sep).join("/");
			if (exceptions.has(name)) continue;
			const source = await readFile(file, "utf8");
			if (!source.includes("tmpdir")) continue;
			const { tokens } = parse(source, { sourceType: "module", plugins: ["typescript"], tokens: true });
			if (tokens?.some((token) => token.value === "tmpdir")) violations.push(name);
		}
	}
	await Promise.all(roots.map((root) => visit(join(packages, root))));
	assert.deepEqual(violations, []);
});
