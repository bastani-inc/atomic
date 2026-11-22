import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { loadSkillsAsync } from "../src/core/skills-async.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow skill names that differ from the parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(false);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the read tool to load a skill's file");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".pi/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.pi/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});

	describe("loadSkillsAsync parity and ignore-file avoidance", () => {
		it("matches loadSkills order, diagnostics, and .gitignore rules while skipping missing ignore-file reads", async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-skills-async-"));
			try {
				const dirA = join(root, "skills-a");
				const dirB = join(root, "skills-b");
				mkdirSync(join(dirA, "alpha"), { recursive: true });
				mkdirSync(join(dirA, "beta"), { recursive: true });
				mkdirSync(join(dirA, "ignored-skill"), { recursive: true });
				mkdirSync(join(dirB, "gamma"), { recursive: true });
				mkdirSync(join(dirB, "alpha"), { recursive: true });

				writeFileSync(join(dirA, ".gitignore"), "ignored-skill/\n");
				writeFileSync(join(dirA, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: First alpha\n---\nBody\n");
				writeFileSync(join(dirA, "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta skill\n---\nBody\n");
				writeFileSync(
					join(dirA, "ignored-skill", "SKILL.md"),
					"---\nname: ignored-skill\ndescription: Should be ignored\n---\nBody\n",
				);
				writeFileSync(join(dirB, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: Gamma skill\n---\nBody\n");
				writeFileSync(
					join(dirB, "alpha", "SKILL.md"),
					"---\nname: alpha\ndescription: Colliding alpha\n---\nBody\n",
				);

				const options = {
					cwd: root,
					agentDir: join(root, "agent"),
					skillPaths: [dirA, join(root, "missing-dir"), dirB],
					includeDefaults: false,
				};
				const syncResult = loadSkills(options);
				const asyncResult = await loadSkillsAsync(options);

				expect(asyncResult.skills).toEqual(syncResult.skills);
				expect(asyncResult.candidates).toEqual(syncResult.candidates);
				expect(asyncResult.diagnostics).toEqual(syncResult.diagnostics);
				expect(asyncResult.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
				expect(asyncResult.diagnostics.some((d) => d.message.includes("does not exist"))).toBe(true);
				expect(asyncResult.diagnostics.some((d) => d.type === "collision")).toBe(true);

				// In a fresh child process, verify loadSkillsAsync does not issue readFile calls for absent ignore files.
				const { spawnSync } = await import("node:child_process");
				const skillsAsyncUrl = new URL("../src/core/skills-async.ts", import.meta.url).href;
				const probe = spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`import { existsSync } from "node:fs";
						import fsPromises from "node:fs/promises";
						import { registerHooks, syncBuiltinESMExports } from "node:module";
						import { fileURLToPath } from "node:url";
						const readIgnoreCalls = [];
						const orig = fsPromises.readFile;
						fsPromises.readFile = function(p, ...rest) {
							const s = String(p);
							if (s.endsWith(".gitignore") || s.endsWith(".ignore") || s.endsWith(".fdignore")) readIgnoreCalls.push(s);
							return orig.call(this, p, ...rest);
						};
						syncBuiltinESMExports();
						registerHooks({
							resolve(specifier, context, next) {
								if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
									const tsUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
									if (existsSync(fileURLToPath(tsUrl))) return { url: tsUrl.href, shortCircuit: true };
								}
								return next(specifier, context);
							},
						});
						const { loadSkillsAsync } = await import(${JSON.stringify(skillsAsyncUrl)});
						await loadSkillsAsync({ cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(join(root, "agent"))}, skillPaths: [${JSON.stringify(dirA)}, ${JSON.stringify(dirB)}], includeDefaults: false });
						process.stdout.write(JSON.stringify(readIgnoreCalls));`,
					],
					{ encoding: "utf8" },
				);
				expect(probe.status, probe.stderr).toBe(0);
				expect(JSON.parse(probe.stdout)).toEqual([join(dirA, ".gitignore")]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
