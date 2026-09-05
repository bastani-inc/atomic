import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext as Ctx, LoadedExtensionInfo } from "@bastani/atomic";
import { afterAll, test } from "vitest";
import * as ext from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager as SM } from "../../packages/coding-agent/src/core/session-manager.ts";
import { collectFeedbackDiagnostics as collect } from "../../packages/feedback/src/diagnostics.ts";

const root = mkdtempSync(join(tmpdir(), "feedback-extension-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("reports authoritative extension status", async () => {
	for (const name of ["user", "bundled"]) mkdirSync(join(root, name));
	const paths = ["user", "bundled"].map((name) => join(root, name, "index.ts"));
	for (const path of paths) writeFileSync(path, "export default function () {}\n");
	const first = await ext.loadExtensionsCached(paths, root);
	await ext.loadExtensionsCached([], root, undefined, undefined, first.runtime);
	const fresh = await ext.loadExtensionsCached([paths[1]], root);
	assert.equal(fresh.runtime.getLoadedExtensions?.()[0]?.name, paths[1]);
	const loadedExtensions: LoadedExtensionInfo[] = [
		{ name: join(homedir(), "my-ext.ts"), configurationOrigin: "atomic" },
		{ name: "user/index.ts", configurationOrigin: "atomic" },
		{ name: "bundled/index.ts", configurationOrigin: "bundled" },
	];
	while (loadedExtensions.length < 60) loadedExtensions.push({ name: "extra", configurationOrigin: "atomic" });
	const ctx = { cwd: root, mode: "print", model: undefined, sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	const before = await collect(
		{ report: "x".repeat(5_000), phase: "before" },
		{ ctx, loadedExtensions, exec: async () => ({ code: 0, stdout: "" }) },
	);
	assert.deepEqual(before.extensions.slice(0, 2), ["~/my-ext.ts", "user/index.ts"]);
	assert.deepEqual([before.extensions.length, before.extensions.join("/").includes(basename(homedir()))], [50, false]);
	assert.equal(before.report.length < 5_000, true);
});
