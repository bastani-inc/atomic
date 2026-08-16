/**
 * Review repair for the L16 frontmatter switch: moving from the hand-rolled
 * line reader to the real YAML parser made previously-loadable agent files
 * vanish with no signal — `description: Deploy: fast` is a nested-mapping
 * error, not a description, and the loader silently skipped the file. These
 * tests pin the diagnostic that now accompanies the skip: the loader
 * reports the file and the parser's message, and `subagent doctor` surfaces
 * it, so a strictness regression can never look like a deleted agent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import type { discoverAgentsAll } from "../../packages/subagents/src/agents/agent-discovery.ts";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.ts";
import { buildDoctorReport } from "../../packages/subagents/src/extension/doctor.ts";
import type { ExtensionConfig } from "../../packages/subagents/src/shared/types-config.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types-nested.ts";

const roots: string[] = [];

function writeAgents(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-yaml-diagnostics-"));
	roots.push(dir);
	for (const [fileName, content] of Object.entries(files)) {
		writeFileSync(join(dir, fileName), content, "utf-8");
	}
	return dir;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GOOD_AGENT = "---\nname: probe\ndescription: probe agent\ntools: read\n---\n\nDo the thing.\n";

function doctorState(): { config: ExtensionConfig; state: SubagentState } {
	return {
		config: {},
		state: {
			baseCwd: tmpdir(),
			currentSessionId: null,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			lastUiContext: null,
		},
	};
}

describe("invalid-YAML agent files produce load diagnostics", () => {
	test("a file the YAML parser rejects is reported, not silently skipped", () => {
		const dir = writeAgents({
			// A colon-space inside a plain scalar parsed fine under the old
			// line reader and is a nested-mapping error under the real one.
			"deploy.md": "---\nname: deploy\ndescription: Deploy: fast\ntools: read\n---\n\nbody\n",
			"good.md": GOOD_AGENT,
		});

		const { agents, diagnostics } = loadAgentsFromDirWithDiagnostics(dir, "user");
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["probe"],
		);

		assert.equal(diagnostics.length, 1);
		const diagnostic = diagnostics[0]!;
		assert.equal(diagnostic.path, join(dir, "deploy.md"));
		assert.ok(diagnostic.message.length > 0, "diagnostic carries the parser's message");
	});

	test("files without frontmatter or with valid YAML produce no diagnostics", () => {
		const dir = writeAgents({
			"note.md": "Just a markdown note that lives next to agents.\n",
			"good.md": GOOD_AGENT,
			"sequence.md": "---\nname: seq\ndescription: seq agent\ntools:\n  - read\n  - bash\n---\n\nbody\n",
		});

		const { agents, diagnostics } = loadAgentsFromDirWithDiagnostics(dir, "user");
		assert.equal(agents.length, 2);
		assert.deepEqual(diagnostics, []);
	});

	test("doctor lists every skipped file with the parser's message", () => {
		const { config, state } = doctorState();
		const skippedPath = join(tmpdir(), "agents", "deploy.md");
		const report = buildDoctorReport({
			cwd: tmpdir(),
			config,
			state,
			paths: { tempRootDir: tmpdir() },
			deps: {
				discoverAgentsAll: () =>
					({
						builtin: [],
						user: [],
						project: [],
						userDir: join(tmpdir(), "agents"),
						projectDir: null,
						userSettingsPath: join(tmpdir(), "settings.json"),
						projectSettingsPath: null,
						diagnostics: [{ path: skippedPath, message: "Nested mappings are not allowed" }],
					}) as ReturnType<typeof discoverAgentsAll>,
				discoverAvailableSkills: () => [],
				diagnoseIntercomBridge: () => ({
					active: false,
					mode: "off",
					wantsIntercom: false,
					piIntercomAvailable: false,
					extensionDir: join(tmpdir(), "extensions", "intercom"),
					orchestratorTarget: undefined,
					reason: "disabled",
				}),
			},
		});

		assert.match(report, /- agents: total 0/);
		// The path is data, not a pattern: on Windows it contains backslashes, which a
		// RegExp reads as escapes and which therefore never match the reported line.
		assert.ok(
			report.includes(
				`- agents: warning — ${skippedPath}: invalid YAML frontmatter (Nested mappings are not allowed); file skipped`,
			),
			report,
		);
	});

	test("doctor reports no warnings when every file parses", () => {
		const { config, state } = doctorState();
		const report = buildDoctorReport({
			cwd: tmpdir(),
			config,
			state,
			paths: { tempRootDir: tmpdir() },
			deps: {
				discoverAgentsAll: () =>
					({
						builtin: [],
						user: [],
						project: [],
						userDir: join(tmpdir(), "agents"),
						projectDir: null,
						userSettingsPath: join(tmpdir(), "settings.json"),
						projectSettingsPath: null,
						diagnostics: [],
					}) as ReturnType<typeof discoverAgentsAll>,
				discoverAvailableSkills: () => [],
				diagnoseIntercomBridge: () => ({
					active: false,
					mode: "off",
					wantsIntercom: false,
					piIntercomAvailable: false,
					extensionDir: join(tmpdir(), "extensions", "intercom"),
					orchestratorTarget: undefined,
					reason: "disabled",
				}),
			},
		});

		assert.doesNotMatch(report, /agents: warning/);
	});
});
