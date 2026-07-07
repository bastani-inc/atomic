import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let tempDir: string;
let agentDir: string;
let cwd: string;
let packageDir: string;

function writeFixturePackage(): void {
	packageDir = join(tempDir, "builtin-package");
	mkdirSync(join(packageDir, "skills", "demo"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({
		name: "@example/builtin-package",
		pi: { skills: ["./skills"] },
	}, null, 2));
	writeFileSync(join(packageDir, "skills", "demo", "SKILL.md"), `---
name: demo-skill
description: Use when verifying deferred resource loading in tests.
---

# Demo
`);
}

describe("DefaultResourceLoader deferResources", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-defer-resources-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFixturePackage();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("skips package resource discovery until the later full reload", async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: [packageDir],
		});

		await loader.reload({ deferExtensions: true, deferResources: true });

		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getWorkflowResources()).toEqual([]);

		await loader.reload();

		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("demo-skill");
	});
});
