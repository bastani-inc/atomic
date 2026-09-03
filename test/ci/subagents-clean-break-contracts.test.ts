import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const guardPath = "test/ci/subagents-clean-break-contracts.test.ts";

function atomicSubagent(...parts: string[]): string {
	return ["ATOMIC", "SUBAGENT", ...parts].join("_");
}

function deletedEnvNames(): readonly string[] {
	return [
		atomicSubagent("ATTEMPT", "IDLE", "TIMEOUT", "MS"),
		atomicSubagent("ATTEMPT", "TIMEOUT", "MS"),
		atomicSubagent("ATTEMPT", "KILL", "GRACE", "MS"),
		atomicSubagent("CHILD"),
		atomicSubagent("FANOUT", "CHILD"),
		atomicSubagent("DEPTH"),
		atomicSubagent("MAX", "DEPTH"),
		atomicSubagent("PARENT", "EVENT", "SINK"),
		atomicSubagent("PARENT", "CONTROL", "INBOX"),
		atomicSubagent("PARENT", "ROOT", "RUN", "ID"),
		atomicSubagent("PARENT", "RUN", "ID"),
		atomicSubagent("PARENT", "CHILD", "INDEX"),
		atomicSubagent("PARENT", "DEPTH"),
		atomicSubagent("PARENT", "PATH"),
		atomicSubagent("PARENT", "CAPABILITY", "TOKEN"),
		atomicSubagent("INHERIT", "PROJECT", "CONTEXT"),
		atomicSubagent("INHERIT", "SKILLS"),
		atomicSubagent("INTERCOM", "SESSION", "NAME"),
		atomicSubagent("ORCHESTRATOR", "TARGET"),
		atomicSubagent("SUPERVISOR", "CAPABILITY"),
		atomicSubagent("SUPERVISOR", "SESSION", "ID"),
		atomicSubagent("RUN", "ID"),
		atomicSubagent("CHILD", "AGENT"),
		atomicSubagent("CHILD", "INDEX"),
		atomicSubagent("STRUCTURED", "OUTPUT", "CAPTURE"),
		atomicSubagent("STRUCTURED", "OUTPUT", "SCHEMA"),
		["ATOMIC", "CODEX", "FAST", "MODE"].join("_"),
		["MCP", "DIRECT", "TOOLS"].join("_"),
		["_", "_", "none", "_", "_"].join(""),
	];
}

const deletedModulePaths = [
	"packages/subagents/src/runs/shared/attempt-watchdog.ts",
	"packages/subagents/src/runs/shared/pi-args.ts",
	"packages/subagents/src/runs/shared/pi-spawn.ts",
	"packages/subagents/src/runs/shared/spawn-env.ts",
	"packages/subagents/src/runs/shared/final-drain.ts",
	"packages/subagents/src/runs/shared/subagent-prompt-runtime.ts",
	"packages/subagents/src/runs/background/async-event-journal.ts",
	"packages/subagents/src/runs/background/async-resume.ts",
	"packages/subagents/src/runs/background/async-status.ts",
	"packages/subagents/src/runs/background/top-level-async.ts",
	"packages/subagents/src/runs/background/completion-claims.ts",
	"packages/subagents/src/runs/background/completion-dedupe.ts",
	"packages/subagents/src/runs/background/stale-run-reconciler.ts",
	"packages/subagents/src/runs/background/run-status.ts",
	"packages/subagents/src/runs/background/run-id-resolver.ts",
	"packages/subagents/src/runs/background/parallel-groups.ts",
	"packages/subagents/src/runs/background/result-watcher.ts",
	"packages/subagents/src/runs/background/result-watcher-data.ts",
	"packages/subagents/src/runs/background/result-file-claims.ts",
	"packages/subagents/src/runs/background/result-delivery-processor.ts",
	"packages/subagents/src/runs/background/result-quarantine.ts",
	"packages/subagents/src/runs/background/result-retry-scheduler.ts",
	"packages/subagents/src/runs/background/result-status.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/process-args.ts",
	"packages/subagents/src/runs/shared/nested-events-control.ts",
	"packages/subagents/src/runs/shared/nested-events-core.ts",
	"packages/subagents/src/runs/shared/nested-events-projection.ts",
	"packages/subagents/src/runs/shared/nested-events-registry.ts",
	"packages/subagents/src/runs/shared/nested-events-sanitize.ts",
	"packages/subagents/src/runs/shared/nested-path.ts",
	"packages/subagents/src/runs/shared/nested-render.ts",
	"packages/subagents/src/runs/foreground/execution-attempt.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-control.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-finalize.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-types.ts",
	// The multi-level nested route/event/control pipeline. Its env resolvers had
	// already become unconditional `return undefined`, so nothing downstream of
	// them could ever run; delegation is fixed at one level. Direct-child live
	// interrupt lookup uses the root-scoped control registry.
	"packages/subagents/src/runs/inprocess/nested-routing.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-api.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-control.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-core.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-paths.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-projection.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-registry.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-rendering.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/nested-sanitize.ts",
	"packages/subagents/src/shared/types-nested.ts",
	// The fanout-child registration door. It had no production importer: the
	// package exposes only `./src/extension/index.ts`, which resolves a
	// child-scoped executor from `ctx.subagentPolicy`.
	"packages/subagents/src/extension/fanout-child.ts",
	"packages/subagents/src/runs/inprocess/attempt-handles.ts",
] as const;

const deletedModulePatterns = [
	/^packages\/subagents\/src\/runs\/background\/subagent-runner[^/]*\.ts$/u,
	/^packages\/subagents\/src\/runs\/background\/async-execution-[^/]+\.ts$/u,
	/^packages\/subagents\/src\/runs\/background\/result-[^/]+\.ts$/u,
] as const;

function trackedFiles(): string[] {
	const result = spawnSyncCollect(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter((file) => file.length > 0);
}

function isChangelogPath(file: string): boolean {
	return file.endsWith("CHANGELOG.md") || file.endsWith("/changelog.mdx");
}

function guardedSource(file: string): string {
	const source = readFileSync(join(root, file), "utf8");
	if (!isChangelogPath(file)) return source;
	const start = source.indexOf("## [Unreleased]");
	if (start < 0) return "";
	const nextSection = source.indexOf("\n## [", start + "## [Unreleased]".length);
	return source.slice(start, nextSection < 0 ? source.length : nextSection);
}

function scanPath(file: string): boolean {
	if (file === guardPath || file.startsWith("specs/") || file.startsWith("research/")) return false;
	if (file.startsWith("packages/coding-agent/dist/")) return false;
	if (file.includes("/test/") || file.startsWith("test/")) return false;
	return file.startsWith("packages/") || file.startsWith("scripts/");
}

function activeSubagentContractPath(file: string): boolean {
	if (isChangelogPath(file) || file.startsWith("research/") || file.startsWith("test/")) return false;
	if (file === "packages/subagents/skills/playwright-cli/references/test-generation.md") return false;
	if (
		file === "specs/2026-03-02-opencode-delegation-streaming-parity.md" ||
		file === "specs/2026-08-04-subagents-inprocess-runner.md"
	)
		return true;
	if (file.startsWith("packages/subagents/")) return true;
	if (file === "packages/intercom/README.md" || file.startsWith("packages/intercom/skills/")) return true;
	return [
		"packages/coding-agent/docs/intercom.md",
		"packages/coding-agent/docs/subagents.md",
		"packages/coding-agent/docs/workflows/api-reference.md",
	].includes(file);
}

function activeSubagentContractSource(file: string): string {
	const source = readFileSync(join(root, file), "utf8");
	if (file === "packages/coding-agent/docs/workflows/api-reference.md") {
		const start = source.indexOf("### `tools` / `noTools` / `excludedTools`");
		assert.notEqual(start, -1, "workflow subagent-tool contract section is missing");
		const end = source.indexOf("\n### ", start + 4);
		return source.slice(start, end < 0 ? source.length : end);
	}
	if (file === "specs/2026-08-04-subagents-inprocess-runner.md") {
		const cleanBreakInventory = source.indexOf("\n## 10. Clean-Break Inventory");
		return source.slice(0, cleanBreakInventory < 0 ? source.length : cleanBreakInventory);
	}
	return source;
}

const staleSubagentContractPatterns = [
	/\bsubagent\s*\(\s*\{[^\n]{0,80}\baction\s*:\s*["']resume["']/iu,
	/\b(?:subagent|child(?:ren)?|sibling(?:s)?)\b[^\n]{0,120}\bresume(?:d|s|ing)?\b/iu,
	/\bresume(?:d|s|ing)?\b[^\n]{0,120}\b(?:subagent|child(?:ren)?|sibling(?:s)?)\b/iu,
	/\binterrupt(?:ed|ion)?\b[^\n]{0,120}\b(?:resumable|paused|pause for resume)\b/iu,
	/\bparent[- ]ask\b[^\n]{0,120}\bpause(?:d|s|ing)?\b/iu,
	/\b(?:run|child) paused after interrupt\b/iu,
	/\bpause to ask the parent\b/iu,
	/\bresume stability\b/iu,
] as const;

function removedResumeSurfaceNames(): string[] {
	return [
		["reload", "Cold", "Child"].join(""),
		["reload", "_cold", "_child"].join(""),
		["resume", "InProcess", "Attempt"].join(""),
	];
}

test("the clean-break env bridge and CLI-child protocol stay absent", () => {
	const files = trackedFiles();
	for (const relative of files.filter(scanPath)) {
		assert.equal(existsSync(join(root, relative)), true, `${relative} listed by git but missing from disk`);
		const source = guardedSource(relative);
		for (const envName of deletedEnvNames()) {
			assert.equal(source.includes(envName), false, `${relative} reintroduced deleted environment key ${envName}`);
		}
		assert.equal(
			source.includes(["build", "Pi", "Args"].join("")),
			false,
			`${relative} reintroduced the deleted CLI argv builder`,
		);
		assert.equal(
			/--mode\s+json\s+-p/u.test(source),
			false,
			`${relative} reintroduced the deleted --mode json -p child protocol`,
		);
	}
	for (const relative of deletedModulePaths) {
		assert.equal(existsSync(join(root, relative)), false, `${relative} was reintroduced`);
	}
	for (const relative of files) {
		for (const pattern of deletedModulePatterns) {
			assert.equal(
				pattern.test(relative),
				false,
				`${relative} matches deleted process-era module pattern ${pattern}`,
			);
		}
	}
});

test("subagent child-resume code and active contracts stay absent", () => {
	const files = trackedFiles();
	const implementationFiles = files.filter(
		(file) =>
			file.startsWith("crates/atomic-natives/") ||
			file.startsWith("packages/subagents/src/") ||
			file === "packages/natives/native/index.d.ts",
	);
	for (const relative of implementationFiles) {
		const source = readFileSync(join(root, relative), "utf8");
		for (const removedName of removedResumeSurfaceNames()) {
			assert.equal(source.includes(removedName), false, `${relative} reintroduced removed ${removedName}`);
		}
	}

	for (const relative of files.filter(activeSubagentContractPath)) {
		const source = activeSubagentContractSource(relative);
		for (const pattern of staleSubagentContractPatterns) {
			assert.equal(pattern.test(source), false, `${relative} contains stale subagent resume contract ${pattern}`);
		}
	}
});
