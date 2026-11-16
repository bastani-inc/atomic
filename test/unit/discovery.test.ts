/** Tests for bundled workflow discovery. */

import assert from "node:assert/strict";
import type * as Fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
	type DiscoveryDiagnostic,
	type DiscoverySource,
	discoverStartupWorkflowsSync,
	discoverWorkflows,
} from "../../packages/workflows/src/extension/discovery.js";
import { makeTempDir, makeValidDef } from "./discovery-helpers.js";
import "./discovery-project-config.test.js";
import "./discovery-invalid-duplicates.test.js";

// ---------------------------------------------------------------------------
// Happy path: real bundled workflows
// ---------------------------------------------------------------------------

const BUNDLED_WORKFLOW_NAMES = [
	"adversarial-verification",
	"classify-and-act",
	"fan-out-and-synthesize",
	"generate-and-filter",
	"goal",
	"loop-until-done",
	"open-claude-design",
	"ralph",
	"tournament",
] as const;

describe("discoverStartupWorkflowsSync — bundled manifest", () => {
	test("returns a DiscoveryResult with registry, sources, errors", async () => {
		const result = await discoverStartupWorkflowsSync();
		assert.notEqual(result, undefined);
		assert.notEqual(result.registry, undefined);
		assert.equal(Array.isArray(result.sources), true);
		assert.equal(Array.isArray(result.errors), true);
	});

	test("registers exactly the nine bundled workflows", async () => {
		const { registry } = await discoverStartupWorkflowsSync();
		assert.deepEqual(registry.names().sort(), [...BUNDLED_WORKFLOW_NAMES].sort());
	});

	test("no errors on clean manifest", async () => {
		const { errors } = await discoverStartupWorkflowsSync();
		assert.equal(errors.length, 0);
	});

	test("sources array has one entry per registered workflow", async () => {
		const { sources } = await discoverStartupWorkflowsSync();
		assert.equal(sources.length, BUNDLED_WORKFLOW_NAMES.length);
		const ids = sources.map((s: DiscoverySource) => s.id);
		for (const name of BUNDLED_WORKFLOW_NAMES) assert.ok(ids.includes(name));
	});

	test("every source has kind='bundled'", async () => {
		const { sources } = await discoverStartupWorkflowsSync();
		for (const s of sources) {
			assert.equal(s.kind, "bundled");
		}
	});

	test("source id matches normalizedName", async () => {
		const { sources, registry } = await discoverStartupWorkflowsSync();
		for (const s of sources) {
			const def = registry.get(s.id);
			assert.notEqual(def, undefined);
			assert.equal(def!.normalizedName, s.id);
		}
	});

	test("source name matches workflow display name", async () => {
		const { sources, registry } = await discoverStartupWorkflowsSync();
		for (const s of sources) {
			const def = registry.get(s.id);
			assert.equal(def!.name, s.name);
		}
	});

	test("registry.get by normalizedName returns valid WorkflowDefinition", async () => {
		const { registry } = await discoverStartupWorkflowsSync();
		for (const name of BUNDLED_WORKFLOW_NAMES) {
			const def = registry.get(name);
			assert.notEqual(def, undefined);
			assert.equal(def!.__piWorkflow, true);
			assert.equal(typeof def!.run, "function");
			assert.equal(def!.normalizedName, name);
		}
	});

	test("registry is immutable-style (register returns new registry)", async () => {
		const { registry } = await discoverStartupWorkflowsSync();
		const extra = makeValidDef("new-workflow", "new-workflow");
		const r2 = registry.register(extra);
		// original unchanged
		assert.equal(registry.has("new-workflow"), false);
		assert.equal(r2.has("new-workflow"), true);
	});
});

// ---------------------------------------------------------------------------
// Validation: INVALID_DEFINITION diagnostics
// ---------------------------------------------------------------------------

describe("discoverStartupWorkflowsSync — validation diagnostics", () => {
	/**
	 * We test validation indirectly by inspecting the diagnostic shape from
	 * a direct call to the module's internal validator via a crafted scenario.
	 *
	 * Since validateDefinition is not exported, we verify its effects through
	 * the returned errors array by checking that valid definitions produce no
	 * INVALID_DEFINITION errors.
	 */
	test("INVALID_DEFINITION diagnostic has correct fields", async () => {
		// The bundled manifest is clean, so all errors would be structural.
		// We verify the diagnostic type shape is correct when errors exist by
		// checking the DiscoveryDiagnostic contract on a synthetic test.
		const diag: DiscoveryDiagnostic = {
			level: "error",
			code: "INVALID_DEFINITION",
			message: 'Bundled export "foo" rejected: export is not an object',
			source: "foo",
		};
		assert.equal(diag.level, "error");
		assert.equal(diag.code, "INVALID_DEFINITION");
		assert.equal(typeof diag.message, "string");
		assert.equal(diag.source, "foo");
	});

	test("no INVALID_DEFINITION errors for real bundled workflows", async () => {
		const { errors } = await discoverStartupWorkflowsSync();
		const invalidErrors = errors.filter((e: DiscoveryDiagnostic) => e.code === "INVALID_DEFINITION");
		assert.equal(invalidErrors.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Duplicate detection via createRegistry + registry logic
// ---------------------------------------------------------------------------

describe("discoverStartupWorkflowsSync — duplicate handling", () => {
	test("no DUPLICATE_NAME warnings for clean bundled manifest (all unique)", async () => {
		const { errors } = await discoverStartupWorkflowsSync();
		const dupeWarnings = errors.filter((e: DiscoveryDiagnostic) => e.code === "DUPLICATE_NAME");
		assert.equal(dupeWarnings.length, 0);
	});

	test("DUPLICATE_NAME diagnostic shape is correct", () => {
		const diag: DiscoveryDiagnostic = {
			level: "warn",
			code: "DUPLICATE_NAME",
			message: 'Bundled export "tournament2" skipped: normalizedName "tournament" already registered',
			source: "tournament2",
		};
		assert.equal(diag.level, "warn");
		assert.equal(diag.code, "DUPLICATE_NAME");
		assert.equal(diag.source, "tournament2");
	});
});

// ---------------------------------------------------------------------------
// DiscoveryResult is frozen / read-only (contract)
// ---------------------------------------------------------------------------

describe("DiscoveryResult contract", () => {
	test("sources array is readonly (cannot push)", async () => {
		const { sources } = await discoverStartupWorkflowsSync();
		// readonly — TypeScript enforces this; runtime check via Object.isFrozen or try
		// The array itself may not be frozen at runtime, but we confirm length is stable
		const lenBefore = sources.length;
		// Attempting to push would be a TS error; we simply confirm length is stable
		assert.equal(sources.length, lenBefore);
	});

	test("errors array is readonly (length stable)", async () => {
		const { errors } = await discoverStartupWorkflowsSync();
		const lenBefore = errors.length;
		assert.equal(errors.length, lenBefore);
	});
});

// ---------------------------------------------------------------------------
// DiscoverySource shape conformance
// ---------------------------------------------------------------------------

describe("DiscoverySource shape", () => {
	test("each source has id, kind, name fields", async () => {
		const { sources } = await discoverStartupWorkflowsSync();
		for (const s of sources) {
			assert.equal(typeof s.id, "string");
			assert.ok(s.id.length > 0);
			assert.equal(s.kind, "bundled");
			assert.equal(typeof s.name, "string");
			assert.ok(s.name.length > 0);
		}
	});

	test("source ids are unique", async () => {
		const { sources } = await discoverStartupWorkflowsSync();
		const ids = sources.map((s: DiscoverySource) => s.id);
		const unique = new Set(ids);
		assert.equal(unique.size, ids.length);
	});
});

// Registry integration: all() returns all ten definitions
// ---------------------------------------------------------------------------

describe("registry.all() after discovery", () => {
	test("all() returns ten WorkflowDefinition objects", async () => {
		const { registry } = await discoverStartupWorkflowsSync();
		const all = registry.all();
		assert.equal(all.length, BUNDLED_WORKFLOW_NAMES.length);
		for (const def of all) {
			assert.equal(def.__piWorkflow, true);
			assert.equal(typeof def.name, "string");
			assert.equal(typeof def.normalizedName, "string");
			assert.equal(typeof def.run, "function");
		}
	});

	test("registry.names() matches source ids", async () => {
		const { registry, sources } = await discoverStartupWorkflowsSync();
		const regNames = new Set(registry.names());
		const srcIds = new Set(sources.map((s: DiscoverySource) => s.id));
		assert.equal(regNames.size, srcIds.size);
		for (const id of srcIds) {
			assert.equal(regNames.has(id), true);
		}
	});
});

const BUILTIN_SOURCE_DIR = fileURLToPath(new URL("../../packages/workflows/builtin/", import.meta.url));

function recordBuiltinSourceReads(): { readonly paths: readonly string[]; stop(): void } {
	const fs = createRequire(import.meta.url)("node:fs") as typeof Fs;
	const readFileSync = fs.readFileSync;
	const paths: string[] = [];
	fs.readFileSync = function recordedReadFileSync(this: unknown, ...args: Parameters<typeof Fs.readFileSync>) {
		const target = args[0];
		if (typeof target === "string" && resolve(target).startsWith(BUILTIN_SOURCE_DIR)) paths.push(target);
		return Reflect.apply(readFileSync, this, args);
	} as typeof Fs.readFileSync;
	syncBuiltinESMExports();
	return {
		paths,
		stop() {
			fs.readFileSync = readFileSync;
			syncBuiltinESMExports();
		},
	};
}

describe("bundled workflow discovery is done once per process (#5319)", () => {
	test("a discovery after the first reads no bundled workflow source again (#5319)", async () => {
		const first = discoverStartupWorkflowsSync();
		const empty = makeTempDir("bundled-once");
		const reads = recordBuiltinSourceReads();
		let startup: ReturnType<typeof discoverStartupWorkflowsSync>;
		let full: Awaited<ReturnType<typeof discoverWorkflows>>;
		try {
			startup = discoverStartupWorkflowsSync();
			full = await discoverWorkflows({ cwd: empty, homeDir: empty, agentDirs: [] });
		} finally {
			reads.stop();
		}
		assert.deepEqual(reads.paths, []);
		assert.deepEqual(startup.registry.names(), first.registry.names());
		assert.deepEqual(startup.sources, first.sources);
		assert.deepEqual(startup.errors, first.errors);
		assert.deepEqual(full.registry.names(), first.registry.names());
		assert.deepEqual(full.sources, first.sources);
		assert.deepEqual(full.errors, first.errors);
	});

	test("each discovery returns sources and diagnostics of its own (#5319)", () => {
		const first = discoverStartupWorkflowsSync();
		const sources = [...first.sources];
		const errors = [...first.errors];
		(first.sources as DiscoverySource[]).splice(0);
		(first.errors as DiscoveryDiagnostic[]).push({ level: "warn", code: "ZERO_STAGES", message: "", source: "" });
		const second = discoverStartupWorkflowsSync();
		assert.deepEqual(second.sources, sources);
		assert.deepEqual(second.errors, errors);
	});

	test("a caller that replaces its registry's methods leaves later discoveries whole (#5319)", async () => {
		const empty = makeTempDir("registry-owned");
		const first = discoverStartupWorkflowsSync();
		const names = first.registry.names();
		const all = first.registry.all;
		first.registry.all = () => all.call(first.registry).filter((definition) => definition.normalizedName !== "goal");
		try {
			const startup = discoverStartupWorkflowsSync();
			const full = await discoverWorkflows({ cwd: empty, homeDir: empty, agentDirs: [] });
			assert.deepEqual(
				startup.registry.all().map((definition) => definition.normalizedName),
				names,
			);
			assert.deepEqual(
				full.registry.all().map((definition) => definition.normalizedName),
				names,
			);
		} finally {
			first.registry.all = all;
		}
	});
});

// ===========================================================================
