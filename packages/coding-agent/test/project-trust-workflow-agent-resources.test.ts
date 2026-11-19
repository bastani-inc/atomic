import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	hasProjectTrustInputs,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../src/core/trust-manager.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch root holding a home directory, an agent directory and a project, with HOME pointed at the home. */
function makeRoot(): { root: string; home: string; agentDir: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-resources-")));
	tempDirs.push(root);
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return { root, home, agentDir };
}

function writeFileEnsuringDir(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** Resolve trust for `cwd` with a UI that records every prompt and answers "Do not trust (this session only)". */
async function resolveWithPrompt(cwd: string, agentDir: string): Promise<{ trusted: boolean; prompts: string[] }> {
	const prompts: string[] = [];
	const context: ProjectTrustContext = {
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			...noOpUIContext,
			select: async (title, options) => {
				prompts.push(title);
				return options.find((option) => option === "Do not trust (this session only)");
			},
		},
	};
	const trusted = await resolveProjectTrusted({
		cwd,
		trustStore: new ProjectTrustStore(agentDir),
		defaultProjectTrust: "ask",
		projectTrustContext: context,
	});
	return { trusted, prompts };
}

describe("project recipes and agents respect project trust", () => {
	test("never trusting a folder hides its legacy recipes even when it contains no active resources", async () => {
		const { root, agentDir } = makeRoot();
		const cwd = join(root, "project");
		writeFileEnsuringDir(join(cwd, ".atomic", "workflows", "flow.ts"), "throw new Error('not executable');");
		const projectTrusted = await resolveProjectTrusted({
			cwd,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "never",
			projectTrustContext: { cwd, mode: "print", hasUI: false, ui: noOpUIContext },
		});
		assert.equal(projectTrusted, false);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const paths = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve();
		assert.deepEqual(paths.legacyWorkflowFiles, []);
	});

	for (const [label, relativePath] of [
		["a workflow module", ".atomic/workflows/flow.ts"],
		["an agent definition", ".atomic/agents/helper.md"],
		["a legacy .pi agent definition", ".pi/agents/helper.md"],
		["an MCP server config", ".atomic/mcp.json"],
	] as const) {
		test(`a project whose only project resource is ${label} asks for trust`, async () => {
			const { root, agentDir } = makeRoot();
			const project = join(root, "project");
			writeFileEnsuringDir(join(project, relativePath), "content");

			assert.equal(hasTrustRequiringProjectResources(project), true);
			assert.equal(hasProjectTrustInputs(project), true);
			const { trusted, prompts } = await resolveWithPrompt(project, agentDir);
			assert.equal(prompts.length, 1);
			assert.equal(trusted, false);
		});
	}

	for (const [label, relativePath] of [
		["an agent definition", ".atomic/agents/helper.md"],
		["a legacy .agents agent definition", ".agents/helper.md"],
		["a settings file", ".atomic/settings.json"],
	] as const) {
		test(`a subdirectory of a project whose root has ${label} asks for trust`, async () => {
			const { root, agentDir } = makeRoot();
			const project = join(root, "project");
			const nested = join(project, "packages", "app");
			mkdirSync(nested, { recursive: true });
			writeFileEnsuringDir(join(project, relativePath), "content");

			assert.equal(hasTrustRequiringProjectResources(nested), true);
			assert.equal(hasProjectTrustInputs(nested), true);
			const { trusted, prompts } = await resolveWithPrompt(nested, agentDir);
			assert.equal(prompts.length, 1);
			assert.equal(trusted, false);
		});
	}

	test("user-level agent definitions in the home directory do not ask for trust", async () => {
		const { home, agentDir } = makeRoot();
		writeFileEnsuringDir(join(home, ".agents", "helper.md"), "content");
		writeFileEnsuringDir(join(home, ".atomic", "agent", "agents", "helper.md"), "content");
		const project = join(home, "project");
		mkdirSync(project, { recursive: true });

		assert.equal(hasTrustRequiringProjectResources(project), false);
		assert.equal(hasProjectTrustInputs(project), false);
		const { trusted, prompts } = await resolveWithPrompt(project, agentDir);
		assert.deepEqual(prompts, []);
		assert.equal(trusted, true);
	});
});
