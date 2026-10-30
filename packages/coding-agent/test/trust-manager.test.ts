import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getProjectTrustPath,
	hasProjectConfigDir,
	hasProjectTrustInputs,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES,
} from "../src/core/trust-manager.ts";

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

	it("detects AGENTS.override.md as an ancestor project trust input", () => {
		const root = createTempProject();
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(hasProjectTrustInputs(nested)).toBe(false);

		writeFileSync(join(root, "AGENTS.override.md"), "project override instructions");
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

describe("project trust on Windows paths", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const homeEnv = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
	const originalEnv = new Map(homeEnv.map((name) => [name, process.env[name]]));

	afterEach(() => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		for (const [name, value] of originalEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	// Regression test for upstream https://github.com/earendil-works/pi/issues/10488
	it("ignores the user .agents/skills dir when the home directory differs only by case", () => {
		const mixedCaseHome = join(createTempProject(), "Home");
		const projectDir = join(mixedCaseHome, "project");
		mkdirSync(join(mixedCaseHome, ".agents", "skills"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		for (const name of homeEnv) delete process.env[name];
		process.env.USERPROFILE = mixedCaseHome.toLowerCase();
		Object.defineProperty(process, "platform", { value: "win32" });

		expect(hasTrustRequiringProjectResources(projectDir)).toBe(false);
		expect(hasProjectTrustInputs(projectDir)).toBe(false);
	});

	// Regression test for upstream https://github.com/earendil-works/pi/issues/10488
	it("matches saved decisions regardless of casing", () => {
		const root = createTempProject();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "Project-Mixed");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const store = new ProjectTrustStore(agentDir);
		store.set(projectDir, true);
		Object.defineProperty(process, "platform", { value: "win32" });

		expect(store.get(projectDir.toLowerCase())).toBe(true);
		store.set(projectDir.toLowerCase(), false);
		const saved = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<string, boolean>;
		expect(Object.values(saved)).toEqual([false]);
		expect(store.get(projectDir)).toBe(false);
	});
});
