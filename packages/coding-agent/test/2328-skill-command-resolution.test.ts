import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { buildSkillCatalog } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function skill(filePath: string, source: "user" | "builtin", body: string): Skill {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `---\nname: tdd\ndescription: ${source} TDD\n---\n\n${body}\n`);
	return {
		name: "tdd",
		description: `${source} TDD`,
		filePath,
		baseDir: join(filePath, ".."),
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: source === "builtin" ? "/packages/workflows" : "local",
			scope: source === "builtin" ? "temporary" : "user",
			origin: source === "builtin" ? "package" : "top-level",
			configurationOrigin: source === "builtin" ? "bundled" : "atomic",
		}),
	};
}

describe("issue #2328 exact skill command resolution", () => {
	const cleanup: Array<() => void> = [];

	afterEach(() => {
		while (cleanup.length > 0) cleanup.pop()?.();
	});

	it("expands an exact qualified selector and records stable candidate identity", async () => {
		const tempDir = join(tmpdir(), `atomic-2328-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const user = skill(join(tempDir, "user", "SKILL.md"), "user", "User body");
		const builtin = skill(join(tempDir, "builtin", "SKILL.md"), "builtin", "Builtin body");
		const catalog = buildSkillCatalog([user, builtin], [user]);
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills: [user], diagnostics: [] }),
			getSkillCatalog: () => catalog,
		};
		const harness: Harness = await createHarness({ resourceLoader });
		cleanup.push(harness.cleanup);

		const expanded = harness.session._expandSkillCommand("/skill:tdd@builtin use exact source");
		const parsed = parseSkillBlock(expanded);

		expect(parsed).toMatchObject({
			name: "tdd@builtin",
			location: builtin.filePath,
			candidateId: catalog.resolve("tdd@builtin").ok ? catalog.resolve("tdd@builtin").candidate.id : undefined,
			userMessage: "use exact source",
		});
		expect(parsed?.content).toContain("Builtin body");
		expect(parsed?.content).not.toContain("User body");
		expect(harness.session.systemPrompt).toContain("<name>tdd@user</name>");
		expect(harness.session.systemPrompt).toContain("<name>tdd@builtin</name>");
		expect(harness.session.systemPrompt).not.toContain("skill_");
	});

	it("represents a configured winner that was not in the discovered candidates", () => {
		const tempDir = join(tmpdir(), `atomic-2328-winner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const original = skill(join(tempDir, "original", "SKILL.md"), "user", "Original body");
		const builtin = skill(join(tempDir, "builtin", "SKILL.md"), "builtin", "Builtin body");
		const configured = skill(join(tempDir, "configured", "SKILL.md"), "user", "Configured body");
		const catalog = buildSkillCatalog([original, builtin], [configured]);

		expect(catalog.candidates).toHaveLength(3);
		expect(catalog.resolve("tdd")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: configured.filePath, description: "user TDD" } },
		});
		expect(catalog.commands.find((command) => command.name === "tdd")?.skill.filePath).toBe(configured.filePath);
	});

	it("reports every qualified lookup failure without falling back to the bare winner", async () => {
		const tempDir = join(tmpdir(), `atomic-2328-illegal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const user = skill(join(tempDir, "user", "SKILL.md"), "user", "User body");
		const builtin = skill(join(tempDir, "builtin", "SKILL.md"), "builtin", "Builtin body");
		const secondBuiltin = skill(join(tempDir, "second-builtin", "SKILL.md"), "builtin", "Second builtin body");
		const catalog = buildSkillCatalog([user, builtin, secondBuiltin], [user]);
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills: [user], diagnostics: [] }),
			getSkillCatalog: () => catalog,
		};
		const harness: Harness = await createHarness({ resourceLoader });
		cleanup.push(harness.cleanup);
		const errors: string[] = [];
		const stopErrors = harness.session.extensionRunner.onError((error) => errors.push(error.error));
		cleanup.push(stopErrors);
		const illegal = ["tdd@", "tdd@unknown", "tdd@user@builtin", "@builtin", "tdd@builtin/extra", "tdd@builtin"];

		for (const selector of illegal) {
			const command = `/skill:${selector}`;
			expect(harness.session._expandSkillCommand(command)).toBe(command);
		}

		expect(errors).toHaveLength(illegal.length);
		expect(errors.every((error) => /skill selector/i.test(error))).toBe(true);
		expect(harness.session._expandSkillCommand("/skill:tdd")).toContain("User body");
	});

	it("keeps bare skill commands working for custom loaders without a catalog method", async () => {
		const tempDir = join(tmpdir(), `atomic-2328-custom-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const custom = skill(join(tempDir, "custom", "SKILL.md"), "user", "Custom loader body");
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({ skills: [custom], diagnostics: [] }),
		};
		const harness: Harness = await createHarness({ resourceLoader });
		cleanup.push(harness.cleanup);

		expect(harness.session._expandSkillCommand("/skill:tdd")).toContain("Custom loader body");
		expect(harness.session.extensionRunner.createContext().getSkillCatalog?.()?.resolve("tdd")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: custom.filePath } },
		});
	});

	it("uses the catalog for SDK and RPC command discovery", async () => {
		const tempDir = join(tmpdir(), `atomic-2328-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		cleanup.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const userPath = join(tempDir, "first", "SKILL.md");
		const packagePath = join(tempDir, "second", "SKILL.md");
		skill(userPath, "user", "First body");
		skill(packagePath, "builtin", "Second body");
		let sdkCommands = () => [] as Array<{ name: string; source: string }>;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			additionalSkillPaths: [userPath, packagePath],
			extensionFactories: [
				(pi) => {
					sdkCommands = () => pi.getCommands();
				},
			],
		});
		await loader.reload();
		const harness: Harness = await createHarness({ resourceLoader: loader });
		cleanup.push(harness.cleanup);
		const expected = loader.getSkillCatalog().commands.map((command) => `skill:${command.name}`);
		expect(harness.session.extensionRunner.createContext().getSkillCatalog?.()).toBe(loader.getSkillCatalog());

		expect(
			sdkCommands()
				.filter((command) => command.source === "skill")
				.map((command) => command.name),
		).toEqual(expected);

		const unusedRuntimeFactory: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("unused runtime factory");
		};
		const runtimeHost = new AgentSessionRuntime(
			harness.session,
			{ cwd, agentDir, settingsManager: harness.settingsManager, resourceLoader: loader } as AgentSessionServices,
			unusedRuntimeFactory,
		);
		const handler = createRpcCommandHandler({
			runtimeHost,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: () => {},
		});
		const response = await handler({ type: "get_commands" });
		if (!response?.success || response.command !== "get_commands") {
			throw new Error("RPC command discovery failed");
		}
		expect(
			response.data.commands.filter((command) => command.source === "skill").map((command) => command.name),
		).toEqual(expected);
	});
});
