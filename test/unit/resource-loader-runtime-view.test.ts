import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { ExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { NODE_TS_SOURCE_ARGS } from "../helpers/node-ts-sources.js";
import { bunExecutable } from "../helpers/runtime.js";

const commandSignalFixture = fileURLToPath(new URL("../fixtures/startup-command-signal.mjs", import.meta.url));
for (const [runtime, executable, args] of [
	["Node", process.execPath, NODE_TS_SOURCE_ARGS],
	["Bun", bunExecutable(), []],
] as const) {
	test.each(["revoked", "metered", "aborted"])(
		`discovery continues after a command's signal is %s (${runtime}, #5639)`,
		(scenario) => {
			const result = spawnSync(executable, [...args, commandSignalFixture, scenario], {
				encoding: "utf8",
				timeout: 60_000,
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		},
	);
}

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
