import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasProjectConfigDir, hasProjectTrustInputs } from "../src/core/trust-manager.ts";

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
	it("detects Atomic project config roots", () => {
		const cwd = createTempProject();

		expect(hasProjectConfigDir(cwd)).toBe(false);
		expect(hasProjectTrustInputs(cwd)).toBe(false);

		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		expect(hasProjectConfigDir(cwd)).toBe(true);
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});

	it("detects legacy .pi project config roots", () => {
		const cwd = createTempProject();

		expect(hasProjectConfigDir(cwd)).toBe(false);
		expect(hasProjectTrustInputs(cwd)).toBe(false);

		mkdirSync(join(cwd, ".pi"), { recursive: true });
		expect(hasProjectConfigDir(cwd)).toBe(true);
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});

	it("detects ancestor context files as project trust inputs", () => {
		const root = createTempProject();
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(hasProjectTrustInputs(nested)).toBe(false);

		writeFileSync(join(root, "AGENTS.md"), "project instructions");
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

			const workspace = join(home, "workspace");
			const nestedProject = join(workspace, "project");
			mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
			mkdirSync(nestedProject, { recursive: true });
			expect(hasProjectTrustInputs(nestedProject)).toBe(true);
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
