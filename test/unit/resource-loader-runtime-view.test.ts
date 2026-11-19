import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { ExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";

class StrictRuntimeLoader extends DefaultResourceLoader {
	private readonly views = new WeakMap<ExtensionRuntime, ExtensionRuntime>();

	override getExtensions() {
		const result = super.getExtensions();
		let view = this.views.get(result.runtime);
		if (!view) {
			view = new Proxy(result.runtime, {
				get(target, key, receiver) {
					if (!Reflect.has(target, key)) throw new Error(`Unknown runtime field: ${String(key)}`);
					return Reflect.get(target, key, receiver);
				},
			});
			this.views.set(result.runtime, view);
		}
		return { ...result, runtime: view };
	}
}

test("deferred trust loads builtins and keeps their diagnostics with a strict SDK runtime view (#5639)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-runtime-view-"));
	try {
		const loader = new StrictRuntimeLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			builtinPackagePaths: [fileURLToPath(new URL("../../packages/intercom", import.meta.url))],
			disabledBuiltinExtensions: ["codemode", "tool-search", "llama.cpp"],
			additionalExtensionPaths: ["builtin:healthy", "builtin:broken"],
			extensionFactories: [
				{ name: "healthy", builtin: true, factory() {} },
				{
					name: "broken",
					builtin: true,
					factory() {
						throw new Error("invalid site configuration");
					},
				},
			],
		});
		let completeTrust!: () => Promise<void>;
		await loader.reload({
			resolveProjectTrust: () => true,
			deferProjectTrust: (complete) => {
				completeTrust = complete;
			},
		});
		await completeTrust();
		const { extensions, errors } = loader.getExtensions();
		assert.ok(extensions.some((extension) => extension.path === "builtin:healthy"));
		assert.deepEqual(errors, [{ path: "builtin:broken", error: "invalid site configuration" }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
