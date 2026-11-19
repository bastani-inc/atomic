import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-resource-disclosure.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function writeSkill(filePath: string, name: string, description: string, body: string): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("issue #2328 skill candidate catalog", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-2328-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPackage(packageName: string, skillName: string, body: string): { root: string; skillPath: string } {
		const root = join(tempDir, packageName);
		mkdirSync(root, { recursive: true });
		const skillPath = join(root, "skills", skillName, "SKILL.md");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: [`skills/${skillName}`] } }),
		);
		writeSkill(skillPath, skillName, `${packageName} ${skillName}`, body);
		return { root, skillPath };
	}

	it("retains a bundled collision candidate while preserving the user winner", async () => {
		const name = "tdd";
		const userPath = join(agentDir, "skills", name, "SKILL.md");
		writeSkill(userPath, name, "User TDD", "User body");
		const builtin = createPackage("builtin-workflows", name, "Builtin body");
		const loader = new DefaultResourceLoader({ cwd, agentDir, builtinPackagePaths: [builtin.root] });

		await loader.reload();

		expect(
			loader
				.getSkills()
				.skills.filter((skill) => skill.name === name)
				.map((skill) => skill.filePath),
		).toEqual([userPath]);
		const catalog = loader.getSkillCatalog();
		expect(
			catalog.candidates
				.filter((candidate) => candidate.skill.name === name)
				.map((candidate) => candidate.skill.filePath),
		).toEqual([userPath, builtin.skillPath]);
		expect(
			catalog.commands.filter((command) => command.name.startsWith("tdd")).map((command) => command.name),
		).toEqual(["tdd", "tdd@user", "tdd@builtin"]);
		expect(catalog.resolve("tdd")).toMatchObject({ ok: true, candidate: { skill: { filePath: userPath } } });
		expect(catalog.resolve("tdd@user")).toMatchObject({ ok: true, candidate: { skill: { filePath: userPath } } });
		expect(catalog.resolve("tdd@builtin")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: builtin.skillPath } },
		});
	});

	it("keeps project precedence and exposes unique project, user, and builtin aliases", async () => {
		const name = "review";
		const projectPath = join(cwd, ".atomic", "skills", name, "SKILL.md");
		const userPath = join(agentDir, "skills", name, "SKILL.md");
		writeSkill(projectPath, name, "Project review", "Project body");
		writeSkill(userPath, name, "User review", "User body");
		const builtin = createPackage("builtin-review", name, "Builtin body");
		const loader = new DefaultResourceLoader({ cwd, agentDir, builtinPackagePaths: [builtin.root] });

		await loader.reload();

		const catalog = loader.getSkillCatalog();
		expect(loader.getSkills().skills.find((skill) => skill.name === name)?.filePath).toBe(projectPath);
		expect(catalog.resolve("review")).toMatchObject({ ok: true, candidate: { skill: { filePath: projectPath } } });
		expect(catalog.resolve("review@project")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: projectPath } },
		});
		expect(catalog.resolve("review@user")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: userPath } },
		});
		expect(catalog.resolve("review@builtin")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: builtin.skillPath } },
		});
	});

	it("uses package aliases when the user family is ambiguous and decorates collision diagnostics", async () => {
		const first = createPackage("user-alpha", "review", "Alpha body");
		const second = createPackage("user-beta", "review", "Beta body");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [first.root, second.root] }));
		const loader = new DefaultResourceLoader({ cwd, agentDir });

		await loader.reload();

		const catalog = loader.getSkillCatalog();
		expect(catalog.resolve("review@user")).toMatchObject({ ok: false, kind: "ambiguous" });
		expect(catalog.resolve("review@user-alpha")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: first.skillPath } },
		});
		expect(catalog.resolve("review@user-beta")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: second.skillPath } },
		});
		const collision = loader
			.getSkills()
			.diagnostics.find(
				(diagnostic) => diagnostic.type === "collision" && diagnostic.collision?.name === "review",
			)?.collision;
		const winner = catalog.candidates.find((candidate) => candidate.skill.filePath === collision?.winnerPath);
		const loser = catalog.candidates.find((candidate) => candidate.skill.filePath === collision?.loserPath);
		expect(collision).toMatchObject({
			winnerCandidateId: winner?.id,
			loserCandidateId: loser?.id,
			winnerSelector: winner?.selector,
			loserSelector: loser?.selector,
		});
		expect(collision?.winnerCandidateId).toMatch(/^skill_[a-f0-9]{20}$/);
		expect(collision?.loserCandidateId).toMatch(/^skill_[a-f0-9]{20}$/);
		initTheme("dark");
		const rendered = InteractiveModeBase.prototype.formatDiagnostics.call(
			{
				formatPathWithSource: (path: string) => path,
				findSourceInfoForPath: () => undefined,
			} as InteractiveModeBase,
			loader.getSkills().diagnostics,
			new Map(),
		);
		expect(rendered).toContain(`(default /skill:review; exact /skill:${winner?.selector})`);
		expect(rendered).toContain(`(/skill:${loser?.selector})`);
		expect(rendered).not.toContain("(skipped)");
	});

	it("uses package aliases for an ambiguous family and keeps identities stable across reload", async () => {
		const first = createPackage("builtin-alpha", "review", "Alpha body");
		const second = createPackage("builtin-beta", "review", "Beta body");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			builtinPackagePaths: [first.root, second.root],
		});

		await loader.reload();
		const initial = loader.getSkillCatalog();
		const initialCandidates = initial.candidates.filter((candidate) => candidate.skill.name === "review");
		expect(
			initial.commands.filter((command) => command.name.startsWith("review")).map((command) => command.name),
		).toEqual(["review", "review@builtin-alpha", "review@builtin-beta"]);
		expect(initial.resolve("review@builtin")).toMatchObject({ ok: false, kind: "ambiguous" });
		expect(initial.resolve("review@missing")).toMatchObject({ ok: false, kind: "unknown" });
		expect(initial.resolve("review@builtin-alpha")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: first.skillPath } },
		});
		expect(initial.commands.every((command) => !command.name.includes("skill_"))).toBe(true);

		await loader.reload();
		const reloaded = loader.getSkillCatalog();
		expect(
			reloaded.candidates

				.filter((candidate) => candidate.skill.name === "review")
				.map((candidate) => ({ id: candidate.id, selector: candidate.selector })),
		).toEqual(initialCandidates.map((candidate) => ({ id: candidate.id, selector: candidate.selector })));
		expect(reloaded.resolve("review@builtin-beta")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: second.skillPath } },
		});
	});

	it("drops stale qualified aliases when a collision disappears on reload", async () => {
		const userDir = join(agentDir, "skills", "tdd");
		const userPath = join(userDir, "SKILL.md");
		writeSkill(userPath, "tdd", "User TDD", "User body");
		const builtin = createPackage("reload-builtin", "tdd", "Builtin body");
		const loader = new DefaultResourceLoader({ cwd, agentDir, builtinPackagePaths: [builtin.root] });

		await loader.reload();
		expect(loader.getSkillCatalog().resolve("tdd@user")).toMatchObject({ ok: true });

		rmSync(userDir, { recursive: true, force: true });
		await loader.reload();

		const reloaded = loader.getSkillCatalog();
		expect(reloaded.candidates.filter((candidate) => candidate.skill.name === "tdd")).toHaveLength(1);
		expect(reloaded.resolve("tdd")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: builtin.skillPath } },
		});
		expect(reloaded.resolve("tdd@user")).toMatchObject({ ok: false, kind: "unknown" });
		expect(reloaded.resolve("tdd@builtin")).toMatchObject({ ok: false, kind: "unknown" });
	});

	it("preserves collision candidates through an identity skills override", async () => {
		const userPath = join(agentDir, "skills", "tdd", "SKILL.md");
		writeSkill(userPath, "tdd", "User TDD", "User body");
		const builtin = createPackage("override-builtin", "tdd", "Builtin body");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			builtinPackagePaths: [builtin.root],
			skillsOverride: (base) => base,
		});

		await loader.reload();

		expect(
			loader
				.getSkillCatalog()
				.candidates.filter((candidate) => candidate.skill.name === "tdd")
				.map((candidate) => candidate.skill.filePath),
		).toEqual([userPath, builtin.skillPath]);
	});

	it("uses the effective skills override object throughout the catalog", async () => {
		const userPath = join(agentDir, "skills", "tdd", "SKILL.md");
		writeSkill(userPath, "tdd", "User TDD", "User body");
		const builtin = createPackage("override-replacement-builtin", "tdd", "Builtin body");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			builtinPackagePaths: [builtin.root],
			skillsOverride: (base) => ({
				...base,
				skills: base.skills.map((skill) =>
					skill.name === "tdd" ? { ...skill, description: "Configured TDD" } : skill,
				),
			}),
		});

		await loader.reload();

		const catalog = loader.getSkillCatalog();
		expect(loader.getSkills().skills[0]?.description).toBe("Configured TDD");
		expect(catalog.resolve("tdd")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: userPath, description: "Configured TDD" } },
		});
		expect(catalog.resolve("tdd@user")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: userPath, description: "Configured TDD" } },
		});
		expect(catalog.commands.find((command) => command.name === "tdd")?.description).toBe("Configured TDD");
		expect(catalog.modelSkills().find((skill) => skill.name === "tdd@user")?.description).toBe("Configured TDD");
	});

	it("reconciles an override through a symlink without duplicate candidates", async () => {
		const userPath = join(agentDir, "skills", "tdd", "SKILL.md");
		const aliasPath = join(tempDir, "tdd-alias.md");
		writeSkill(userPath, "tdd", "User TDD", "User body");
		symlinkSync(userPath, aliasPath);
		const builtin = createPackage("override-alias-builtin", "tdd", "Builtin body");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			builtinPackagePaths: [builtin.root],
			skillsOverride: (base) => ({
				...base,
				skills: base.skills.map((skill) =>
					skill.name === "tdd" ? { ...skill, filePath: aliasPath, description: "Aliased TDD" } : skill,
				),
			}),
		});

		await loader.reload();

		const catalog = loader.getSkillCatalog();
		const tddCandidates = catalog.candidates.filter((candidate) => candidate.skill.name === "tdd");
		expect(tddCandidates).toHaveLength(2);
		expect(new Set(tddCandidates.map((candidate) => candidate.id)).size).toBe(2);
		expect(catalog.resolve("tdd")).toMatchObject({
			ok: true,
			candidate: { skill: { filePath: aliasPath, description: "Aliased TDD" } },
		});
	});

	it("dedupes same-file aliases before cataloging candidates", async () => {
		const skillPath = join(tempDir, "source", "aliased", "SKILL.md");
		const aliasPath = join(tempDir, "alias.md");
		writeSkill(skillPath, "aliased", "Aliased skill", "Aliased body");
		symlinkSync(skillPath, aliasPath);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			additionalSkillPaths: [skillPath, aliasPath],
		});

		await loader.reload();

		expect(loader.getSkillCatalog().candidates).toHaveLength(1);
		expect(loader.getSkills().skills).toHaveLength(1);
	});
});
