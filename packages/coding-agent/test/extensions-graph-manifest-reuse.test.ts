import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

interface ReuseTestState {
	evaluations?: number;
}

function state(): ReuseTestState {
	const global = globalThis as typeof globalThis & { __graphManifestReuseTest?: ReuseTestState };
	global.__graphManifestReuseTest ??= {};
	return global.__graphManifestReuseTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __graphManifestReuseTest?: ReuseTestState }).__graphManifestReuseTest;
}

type ValueFactory = () => string;

async function loadGated(entry: string): Promise<ValueFactory> {
	const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
	if (typeof factory !== "function") throw new Error("extension factory did not load");
	return factory as unknown as ValueFactory;
}

describe("extension graph manifest hash-gated reuse", () => {
	const roots: string[] = [];

	beforeEach(() => {
		resetState();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
		}
		resetState();
	});

	function writeChainFixture(): { entry: string; chainC: string } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-graph-reuse-"));
		roots.push(root);
		const entry = path.join(root, "extension.ts");
		const chainA = path.join(root, "chain-a.ts");
		const chainB = path.join(root, "chain-b.ts");
		const chainC = path.join(root, "chain-c.ts");
		fs.writeFileSync(
			entry,
			`import { valueA } from "./chain-a.js";
const testState = ((globalThis as { __graphManifestReuseTest?: { evaluations?: number } }).__graphManifestReuseTest ??= {});
testState.evaluations = (testState.evaluations ?? 0) + 1;
export default function () {
	return valueA;
}
`,
		);
		fs.writeFileSync(chainA, `import { valueB } from "./chain-b.js";\nexport const valueA = valueB + ":a";\n`);
		fs.writeFileSync(chainB, `import { valueC } from "./chain-c.js";\nexport const valueB = valueC + ":b";\n`);
		fs.writeFileSync(chainC, `export const valueC = "c";\n`);
		return { entry, chainC };
	}

	it("reuses the cached factory when the recorded graph is unchanged", async () => {
		const { entry } = writeChainFixture();

		const first = await loadGated(entry);
		const second = await loadGated(entry);

		expect(state().evaluations).toBe(1);
		expect(second).toBe(first);
		expect(second()).toBe("c:b:a");
	});

	it("re-evaluates and observes new code after a transitively imported file changes", async () => {
		const { entry, chainC } = writeChainFixture();

		const first = await loadGated(entry);
		expect(first()).toBe("c:b:a");

		fs.writeFileSync(chainC, `export const valueC = "c-edited";\n`);
		const second = await loadGated(entry);

		expect(state().evaluations).toBe(2);
		expect(second).not.toBe(first);
		expect(second()).toBe("c-edited:b:a");
	});

	it("re-evaluates and extends the manifest after a new import joins the graph", async () => {
		const { entry, chainC } = writeChainFixture();
		const chainD = path.join(path.dirname(chainC), "chain-d.ts");

		await loadGated(entry);
		const before = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(Object.keys(before?.files ?? {}).some((filePath) => filePath.endsWith("chain-d.ts"))).toBe(false);

		fs.writeFileSync(chainD, `export const valueD = "d";\n`);
		fs.writeFileSync(chainC, `import { valueD } from "./chain-d.js";\nexport const valueC = "c-" + valueD;\n`);
		const reloaded = await loadGated(entry);

		expect(state().evaluations).toBe(2);
		expect(reloaded()).toBe("c-d:b:a");
		const after = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(Object.keys(after?.files ?? {}).some((filePath) => filePath.endsWith("chain-d.ts"))).toBe(true);
	});

	it("invalidates reuse when a dependency loaded during factory execution changes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-graph-reuse-deferred-"));
		roots.push(root);
		const entry = path.join(root, "extension.ts");
		const deferred = path.join(root, "deferred.ts");
		fs.writeFileSync(
			entry,
			`const testState = ((globalThis as { __graphManifestReuseTest?: { evaluations?: number } }).__graphManifestReuseTest ??= {});
testState.evaluations = (testState.evaluations ?? 0) + 1;
export default function () {
	return (require("./deferred.ts") as { value: string }).value;
}
`,
		);
		fs.writeFileSync(deferred, `export const value = "before";\n`);

		const first = await loadGated(entry);
		expect(first()).toBe("before");
		const manifest = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(Object.keys(manifest?.files ?? {}).some((filePath) => filePath.endsWith("deferred.ts"))).toBe(true);

		fs.writeFileSync(deferred, `export const value = "after";\n`);
		const second = await loadGated(entry);

		expect(state().evaluations).toBe(2);
		expect(second).not.toBe(first);
		expect(second()).toBe("after");
	});

	it("invalidates reuse when a dependency is loaded from a non-native thenable returned by the factory", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-graph-reuse-thenable-"));
		roots.push(root);
		const entry = path.join(root, "extension.ts");
		const deferred = path.join(root, "deferred.ts");
		fs.writeFileSync(
			entry,
			`const testState = ((globalThis as { __graphManifestReuseTest?: { evaluations?: number } }).__graphManifestReuseTest ??= {});
testState.evaluations = (testState.evaluations ?? 0) + 1;
export default function () {
	return {
		then(resolve: (value: string) => void) {
			resolve((require("./deferred.ts") as { value: string }).value);
		},
	};
}
`,
		);
		fs.writeFileSync(deferred, `export const value = "before";\n`);

		const first = await loadGated(entry);
		await expect(Promise.resolve(first() as unknown as PromiseLike<string>)).resolves.toBe("before");
		const manifest = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(Object.keys(manifest?.files ?? {}).some((filePath) => filePath.endsWith("deferred.ts"))).toBe(true);

		fs.writeFileSync(deferred, `export const value = "after";\n`);
		const second = await loadGated(entry);

		expect(state().evaluations).toBe(2);
		expect(second).not.toBe(first);
		await expect(Promise.resolve(second() as unknown as PromiseLike<string>)).resolves.toBe("after");
	});

	it("invalidates reuse when a dependency is loaded from a callable thenable returned by the factory", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-graph-reuse-callable-thenable-"));
		roots.push(root);
		const entry = path.join(root, "extension.ts");
		const deferred = path.join(root, "deferred.ts");
		fs.writeFileSync(
			entry,
			`const testState = ((globalThis as { __graphManifestReuseTest?: { evaluations?: number } }).__graphManifestReuseTest ??= {});
testState.evaluations = (testState.evaluations ?? 0) + 1;
export default function () {
	const thenable = () => {};
	(thenable as unknown as { then: (resolve: (value: string) => void) => void }).then = (resolve) => {
		resolve((require("./deferred.ts") as { value: string }).value);
	};
	return thenable;
}
`,
		);
		fs.writeFileSync(deferred, `export const value = "before";\n`);

		const first = await loadGated(entry);
		await expect(Promise.resolve(first() as unknown as PromiseLike<string>)).resolves.toBe("before");
		const manifest = extensionLoaderTestHooks.readExtensionGraphManifest(entry);
		expect(Object.keys(manifest?.files ?? {}).some((filePath) => filePath.endsWith("deferred.ts"))).toBe(true);

		fs.writeFileSync(deferred, `export const value = "after";\n`);
		const second = await loadGated(entry);

		expect(state().evaluations).toBe(2);
		expect(second).not.toBe(first);
		await expect(Promise.resolve(second() as unknown as PromiseLike<string>)).resolves.toBe("after");
	});

	it("falls back to fresh evaluation when the manifest is missing or corrupt", async () => {
		const { entry } = writeChainFixture();

		await loadGated(entry);
		fs.rmSync(extensionLoaderTestHooks.graphManifestPath(entry), { force: true });
		const afterMissing = await loadGated(entry);
		expect(state().evaluations).toBe(2);
		expect(afterMissing()).toBe("c:b:a");

		fs.writeFileSync(extensionLoaderTestHooks.graphManifestPath(entry), "{ not json");
		const afterCorrupt = await loadGated(entry);
		expect(state().evaluations).toBe(3);
		expect(afterCorrupt()).toBe("c:b:a");

		// The fallback evaluation rewrote a valid manifest, so reuse resumes.
		const reused = await loadGated(entry);
		expect(state().evaluations).toBe(3);
		expect(reused).toBe(afterCorrupt);
	});
});
