import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runMigrations } from "../src/migrations.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `atomic-migrations-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function withAgentDir<T>(agentDir: string, fn: () => T): T {
	const previous = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previous;
		}
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("project-trust gated migrations", () => {
	it("skips project-local migrations while project trust is false", () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectConfigDir = join(projectDir, ".atomic");
		mkdirSync(join(projectConfigDir, "commands"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		withAgentDir(agentDir, () => runMigrations(projectDir, { projectTrusted: false }));

		expect(existsSync(join(projectConfigDir, "commands"))).toBe(true);
		expect(existsSync(join(projectConfigDir, "prompts"))).toBe(false);
	});

	it("runs project-local migrations when project trust is allowed", () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectConfigDir = join(projectDir, ".atomic");
		mkdirSync(join(projectConfigDir, "commands"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		withAgentDir(agentDir, () => runMigrations(projectDir, { projectTrusted: true }));

		expect(existsSync(join(projectConfigDir, "prompts"))).toBe(true);
	});
});
