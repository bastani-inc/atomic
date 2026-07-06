import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProjectTrustPath, hasProjectConfigDir, hasProjectTrustInputs, hasTrustRequiringProjectResources, ProjectTrustStore, TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES } from "../src/core/trust-manager.ts";

const tempDirs: string[] = [];

function createTempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-trust-manager-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("project trust input detection", () => {
	it("treats empty or inert Atomic project config roots as config dirs but not trust inputs", () => {
		const cwd = createTempProject();

		expect(hasProjectConfigDir(cwd)).toBe(false);
		expect(hasProjectTrustInputs(cwd)).toBe(false);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

		mkdirSync(join(cwd, ".atomic", "todos"), { recursive: true });
		mkdirSync(join(cwd, ".atomic", "sessions"), { recursive: true });
		expect(hasProjectConfigDir(cwd)).toBe(true);
		expect(hasProjectTrustInputs(cwd)).toBe(false);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
	});

	it("treats empty or inert legacy .pi project config roots as config dirs but not trust inputs", () => {
		const cwd = createTempProject();

		expect(hasProjectConfigDir(cwd)).toBe(false);
		expect(hasProjectTrustInputs(cwd)).toBe(false);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

		mkdirSync(join(cwd, ".pi", "sessions"), { recursive: true });
		expect(hasProjectConfigDir(cwd)).toBe(true);
		expect(hasProjectTrustInputs(cwd)).toBe(false);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
	});

	it("detects trust-requiring resources in Atomic and legacy project config roots", () => {
		for (const configDirName of [".atomic", ".pi"] as const) {
			for (const entry of TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES) {
				const cwd = createTempProject();
				mkdirSync(join(cwd, configDirName), { recursive: true });
				if (entry.endsWith(".json") || entry.endsWith(".md")) {
					writeFileSync(join(cwd, configDirName, entry), "{}");
				} else {
					mkdirSync(join(cwd, configDirName, entry), { recursive: true });
				}

				expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
				expect(hasProjectTrustInputs(cwd)).toBe(true);
			}
		}
	});

	it("detects ancestor context files as project trust inputs", () => {
		const root = createTempProject();
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(hasProjectTrustInputs(nested)).toBe(false);

		writeFileSync(join(root, "AGENTS.md"), "project instructions");
		expect(hasProjectTrustInputs(nested)).toBe(true);

		writeFileSync(join(root, "CLAUDE.md"), "project instructions");
		expect(hasProjectTrustInputs(nested)).toBe(true);
	});

	it("detects ancestor .agents skills as project trust inputs", () => {
		const root = createTempProject();
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(hasProjectTrustInputs(nested)).toBe(false);

		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		expect(hasProjectTrustInputs(nested)).toBe(true);
	});

	it("does not treat user-global ~/.agents skills as project trust inputs", () => {
		const home = createTempProject();
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			mkdirSync(join(home, ".agents", "skills"), { recursive: true });
			const project = join(home, "project");
			mkdirSync(project, { recursive: true });

			expect(hasProjectTrustInputs(project)).toBe(false);
			expect(hasTrustRequiringProjectResources(project)).toBe(false);

			const workspace = join(home, "workspace");
			const nestedProject = join(workspace, "project");
			mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
			mkdirSync(nestedProject, { recursive: true });
			expect(hasProjectTrustInputs(nestedProject)).toBe(true);
			expect(hasTrustRequiringProjectResources(nestedProject)).toBe(true);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
		}
	});
});

describe("ProjectTrustStore", () => {
	it("reads trust.json with a leading UTF-8 BOM", () => {
		const agentDir = createTempProject();
		const cwd = createTempProject();
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, `\uFEFF${JSON.stringify({ [getProjectTrustPath(cwd)]: true })}`);

		expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
	});
});
