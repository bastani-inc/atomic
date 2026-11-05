import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { GitProvisionError } from "../../../packages/coding-agent/src/utils/git-errors.js";
import type { GitRelease } from "../../../packages/coding-agent/src/utils/tools-manager.js";

const tools: typeof import("../../../packages/coding-agent/src/utils/tools-manager.js") = await import(
	process.env.CHAOS_TOOLS_MODULE ?? "../../../packages/coding-agent/src/utils/tools-manager.js"
);
const asset = { name: "fake-git.tar.gz", sha256: process.env.CHAOS_SHA256 ?? "" };
const release: GitRelease = {
	repo: "example/fake-git",
	tag: process.env.CHAOS_TAG ?? "v2",
	version: "2.56.0",
	assets: {
		"darwin-x64": asset,
		"darwin-arm64": asset,
		"linux-x64": asset,
		"linux-arm64": asset,
		"linux-arm": asset,
		"win32-x64": asset,
		"win32-arm64": asset,
		"win32-ia32": asset,
	},
};
const SAMPLES_PER_PHASE = 40;
const MAX_GATE_CHECKS = 3_000;

async function waitForGate(path: string): Promise<void> {
	for (let check = 0; !existsSync(path); check++) {
		assert.ok(check < MAX_GATE_CHECKS, "reader gate was not opened");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}

try {
	const report = await tools.withGitProvisionSettingsForTest({ release }, async () => {
		const cached = tools.resolveGitSync();
		writeFileSync(process.env.CHAOS_READER_READY ?? "", "ready");
		let samples = 0;
		let selectedPath = cached.path;
		for (const phase of [1, 2]) {
			await waitForGate(process.env[`CHAOS_READER_GATE_${phase}`] ?? "");
			for (let sample = 0; sample < SAMPLES_PER_PHASE; sample++) {
				const selected = tools.resolveGitSync();
				selectedPath = selected.path;
				for (const git of [cached, selected]) {
					assert.ok(existsSync(git.env.GIT_EXEC_PATH ?? ""));
					assert.ok(existsSync(git.env.GIT_TEMPLATE_DIR ?? ""));
					const result = spawnSync(git.path, ["--check-helpers"], { env: git.env, encoding: "utf8" });
					assert.equal(result.status, 0, String(result.stderr));
					assert.equal(result.stdout.trim(), "git version 2.56.0");
				}
				samples++;
			}
			writeFileSync(
				process.env[`CHAOS_READER_REPORT_${phase}`] ?? "",
				JSON.stringify({ ok: true, samples, cachedPath: cached.path, selectedPath }),
			);
		}
		return { ok: true, samples, cachedPath: cached.path, selectedPath };
	});
	process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
	const failure =
		error instanceof GitProvisionError
			? error.toJSON()
			: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				};
	const report = { ok: false, error: failure };
	for (const phase of [1, 2]) {
		const path = process.env[`CHAOS_READER_REPORT_${phase}`];
		if (path !== undefined) writeFileSync(path, JSON.stringify(report));
	}
	process.stdout.write(`${JSON.stringify(report)}\n`);
}
