import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "../src/core/trust-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Regression tests for upstream https://github.com/earendil-works/pi/issues/10947
describe("saved project trust for projects without trust inputs", () => {
	it("resolveProjectTrusted honors the saved decision before auto-trust", async () => {
		const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "atomic-project-trust-saved-")));
		tempDirs.push(tempRoot);
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		// Nothing in the project asks for trust, so only the saved decision can say no.
		expect(hasProjectTrustInputs(projectDir)).toBe(false);

		const trustStore = new ProjectTrustStore(agentDir);
		const resolve = () =>
			resolveProjectTrusted({
				cwd: projectDir,
				trustStore,
				projectTrustContext: createProjectTrustContext({
					cwd: projectDir,
					mode: "print",
					settingsManager: SettingsManager.inMemory(),
					hasUI: false,
				}),
			});

		expect(await resolve()).toBe(true);
		trustStore.set(projectDir, false);
		expect(await resolve()).toBe(false);
		trustStore.set(projectDir, true);
		expect(await resolve()).toBe(true);
	});
});
