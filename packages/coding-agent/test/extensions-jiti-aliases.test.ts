import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createJiti } from "jiti";
import { afterEach, test } from "vitest";
import { normalizeJitiAliases } from "../src/core/extensions/jiti-aliases.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Files under a temporary root, returning the root. */
function tree(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-jiti-aliases-"));
	roots.push(root);
	for (const file of files) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), "export {};\n");
	}
	return root;
}

function resolveAll(aliases: Record<string, string>, root: string, specifiers: string[]): Array<string | undefined> {
	const jiti = createJiti(join(root, "importer.ts"), { alias: aliases, fsCache: false, moduleCache: false });
	return specifiers.map((specifier) => {
		try {
			return jiti.resolve(specifier);
		} catch {
			return undefined;
		}
	});
}

test("jiti resolves every specifier through the normalized aliases as through the original ones", () => {
	const root = tree([
		"pkg/index.js",
		"pkg/sub/index.js",
		"pkg/sub/deep.js",
		"pkg-extra/index.js",
		"scoped/a.js",
		"scoped/b/index.js",
		"chained/target.js",
	]);
	// Shallow entries first and a chain, so normalization reorders and rewrites them.
	const original: Record<string, string> = {
		"@scope/pkg": join(root, "pkg", "index.js"),
		"@scope/pkg/sub": join(root, "pkg", "sub", "index.js"),
		"@scope/pkg-extra": join(root, "pkg-extra", "index.js"),
		"@scope/pkg/sub/deep": join(root, "pkg", "sub", "deep.js"),
		scoped: join(root, "scoped"),
		"scoped/b": join(root, "scoped", "b", "index.js"),
		"#chain": "scoped/a.js",
		"#chained": join(root, "chained"),
	};
	const specifiers = [
		...Object.keys(original),
		"@scope/pkg/sub/deep",
		"scoped/a.js",
		"scoped/b",
		"#chained/target.js",
		"@scope/pkg-extra",
	];

	assert.deepEqual(
		resolveAll(normalizeJitiAliases(original), root, specifiers),
		resolveAll(original, root, specifiers),
	);
});

test("jiti uses the normalized aliases as they are instead of normalizing them again", () => {
	const root = tree(["first.js", "second.js"]);
	const aliases = normalizeJitiAliases({ target: join(root, "first.js") });
	const jiti = createJiti(join(root, "importer.ts"), { alias: aliases, fsCache: false, moduleCache: false });

	aliases.target = join(root, "second.js");

	assert.equal(normalize(jiti.resolve("target")), join(root, "second.js"));
});

test("the extension loader gives jiti host aliases it does not normalize again for every module", async () => {
	const root = tree(["replacement.js"]);
	const aliases = await extensionLoaderTestHooks.getAliases();
	const jiti = createJiti(join(root, "importer.ts"), { alias: aliases, fsCache: false, moduleCache: false });
	const original = aliases["@bastani/atomic"];
	assert.ok(original);
	try {
		aliases["@bastani/atomic"] = join(root, "replacement.js");
		assert.equal(normalize(jiti.resolve("@bastani/atomic")), join(root, "replacement.js"));
	} finally {
		aliases["@bastani/atomic"] = original;
	}
});
