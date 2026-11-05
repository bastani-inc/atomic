import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { clearExtensionCache, loadExtensions } from "../../../src/core/extensions/loader.js";

interface TestState {
	depValue?: unknown;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionRealpathTest?: TestState };
	if (!global.__extensionRealpathTest) {
		global.__extensionRealpathTest = {};
	}
	return global.__extensionRealpathTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionRealpathTest?: TestState }).__extensionRealpathTest;
}

const roots: string[] = [];

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function fixture(): string {
	const root = join(tmpdir(), `pi-ext-realpath-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	roots.push(root);
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root && existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
	resetState();
	clearExtensionCache();
});

describe("regression #8092: extension entries are realpath'd before jiti load", () => {
	it("loads an extension whose declared dep is only reachable via the pnpm store (pi #8092)", async () => {
		const root = fixture();

		// pnpm isolated layout: node_modules/<pkg> is a symlink into the
		// virtual store, and declared deps exist only as store siblings.
		const storePkgDir = join(root, "node_modules", ".pnpm", "@test+ext@1.0.0", "node_modules", "@test");
		const extDir = join(storePkgDir, "ext");
		const depDir = join(storePkgDir, "dep");
		mkdirSync(extDir, { recursive: true });
		mkdirSync(depDir, { recursive: true });

		writeFileSync(join(depDir, "index.js"), `export const value = 42;\n`, "utf-8");
		writeFileSync(
			join(extDir, "index.ts"),
			`
import { value } from "@test/dep";

export default function () {
	(globalThis.__extensionRealpathTest ??= {}).depValue = value;
}
`,
			"utf-8",
		);

		const topLevel = join(root, "node_modules", "@test");
		mkdirSync(topLevel, { recursive: true });
		// Junctions (win32) require an absolute target; pnpm's own relative
		// link targets are equivalent here since the store path is absolute.
		symlinkSync(join(storePkgDir, "ext"), join(topLevel, "ext"), DIRECTORY_LINK_TYPE);

		const entry = join(topLevel, "ext", "index.ts");
		assert.equal(existsSync(entry), true);

		const result = await loadExtensions([entry], root);

		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.equal(state().depValue, 42);
	});
});
