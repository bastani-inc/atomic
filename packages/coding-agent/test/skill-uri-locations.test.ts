import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import { withBuiltinResourceLoader } from "../src/core/builtin-resource-loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSkillCatalog } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createSkillRouter } from "../src/core/tools/skill-protocol.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function writeSkill(dir: string, name: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, `---\nname: "${name}"\ndescription: ${name} skill\n---\n${body}\n`);
	return file;
}

describe("skill:// locations", () => {
	let root: string;
	let harness: Harness | undefined;
	let userSkillFile: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "atomic-skill-uri-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });

		// User skill whose name the builtin tdd skill also uses.
		userSkillFile = writeSkill(join(agentDir, "skills", "tdd"), "tdd", "User TDD body");
		mkdirSync(join(agentDir, "skills", "tdd", "references"));
		writeFileSync(join(agentDir, "skills", "tdd", "references", "guide.md"), "intro\nuser guide needle\n");
		writeFileSync(join(root, "secret.txt"), "outside the skill\n");

		// Project skill with a script.
		const review = join(cwd, ".atomic", "skills", "review");
		writeSkill(review, "review", "line one\nline two\nline three");
		mkdirSync(join(review, "scripts"));
		writeFileSync(join(review, "scripts", "hello.sh"), "#!/bin/sh\necho hello from the review script\n");
		chmodSync(join(review, "scripts", "hello.sh"), 0o755);

		// Package skill with a dotted name.
		const pkg = join(root, "pkg");
		writeSkill(join(pkg, "skills", "docs"), "docs.v2", "Package docs body");
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "docs-pkg", pi: { skills: ["skills/docs"] } }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
		await loader.reload();

		// Extension-registered skill whose name needs escaping.
		const notes = join(root, "extension-skills", "notes");
		writeSkill(notes, "acme:team notes", "Extension notes body");
		await loader.extendResources({
			skillPaths: [
				{
					path: notes,
					metadata: { source: "extension:acme", scope: "temporary", origin: "top-level", baseDir: notes },
				},
			],
		});

		const resourceLoader = await withBuiltinResourceLoader(loader, cwd, agentDir, {
			subagents: true,
			mcp: false,
			"web-access": false,
			intercom: false,
		});
		harness = await createHarness({ resourceLoader, cwd });
	});

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	/** Runs the tool calls as one model turn and returns each call's result text by id. */
	async function call(calls: Record<string, { tool: string; args: Record<string, unknown> }>) {
		const results = new Map<string, string>();
		harness!.setResponses([
			fauxAssistantMessage(
				Object.entries(calls).map(([id, { tool, args }]) => fauxToolCall(tool, args, { id })),
				{ stopReason: "toolUse" },
			),
			(context) => {
				for (const message of context.messages)
					if (message.role === "toolResult") results.set(message.toolCallId, getMessageText(message));
				return fauxAssistantMessage("done");
			},
		]);
		await harness!.session.prompt("use the skills");
		return results;
	}

	it("lists every skill at a skill:// location and names no absolute path", () => {
		const prompt = harness!.session.systemPrompt;
		for (const location of [
			"skill://tdd@user",
			"skill://tdd@builtin",
			"skill://review",
			"skill://docs.v2",
			"skill://acme%3Ateam%20notes",
			"skill://agent-browser",
		])
			assert.ok(prompt.includes(`<location>${location}</location>`), `missing ${location}`);
		const skills = prompt.slice(prompt.indexOf("The following skills"), prompt.indexOf("</available_skills>"));
		assert.ok(skills.includes("<available_skills>"));
		assert.ok(!skills.includes(root), "the skills list names a temporary skill path");
		assert.doesNotMatch(skills, /SKILL\.md|Use absolute paths/);
		assert.ok(prompt.includes("A file the skill references relative to its own directory is skill://<name>/"));
	});

	it("reads and searches every source's skills, the files inside them and their lines", async () => {
		const results = await call({
			user: { tool: "read", args: { path: "skill://tdd@user" } },
			project: { tool: "read", args: { path: "skill://review" } },
			lines: { tool: "read", args: { path: "skill://review:5-6" } },
			pkg: { tool: "read", args: { path: "skill://docs.v2" } },
			extension: { tool: "read", args: { path: "skill://acme%3Ateam%20notes" } },
			builtin: { tool: "read", args: { path: "skill://agent-browser" } },
			file: { tool: "read", args: { path: "skill://tdd/references/guide.md" } },
			fileLine: { tool: "read", args: { path: "skill://tdd/references/guide.md:2-2" } },
			find: { tool: "find", args: { paths: ["skill://tdd/references/*.md"] } },
			search: { tool: "search", args: { pattern: "needle", paths: "skill://tdd/references/guide.md" } },
			searchSkill: { tool: "search", args: { pattern: "Package docs", paths: "skill://docs.v2" } },
		});
		assert.match(
			results.get("user") ?? "",
			/^Base directory for this skill: skill:\/\/tdd@user\/\n[\s\S]*User TDD body/,
		);
		assert.match(results.get("project") ?? "", /line one/);
		assert.match(results.get("lines") ?? "", /line one\nline two/);
		assert.doesNotMatch(results.get("lines") ?? "", /description:|Base directory/);
		assert.match(results.get("pkg") ?? "", /Package docs body/);
		assert.match(results.get("extension") ?? "", /Extension notes body/);
		assert.match(results.get("builtin") ?? "", /agent-browser/);
		assert.match(results.get("file") ?? "", /user guide needle/);
		assert.doesNotMatch(results.get("file") ?? "", /Base directory/);
		assert.equal(results.get("fileLine"), "intro\nuser guide needle");
		assert.match(results.get("find") ?? "", /guide\.md/);
		assert.match(results.get("search") ?? "", /skill:\/\/tdd\/references\/guide\.md:2: user guide needle/);
		assert.match(results.get("searchSkill") ?? "", /Package docs body/);
	});

	it("resolves a bare name to the precedence winner and a qualified name to that skill", async () => {
		const results = await call({
			bare: { tool: "read", args: { path: "skill://tdd" } },
			builtin: { tool: "read", args: { path: "skill://tdd@builtin" } },
		});
		assert.match(results.get("bare") ?? "", /User TDD body/);
		assert.doesNotMatch(results.get("builtin") ?? "", /User TDD body/);
		assert.match(results.get("builtin") ?? "", /Test-Driven Development/);
	});

	// Bash quoting of expanded paths is POSIX-only, as in bash-internal-url-quoting.test.ts.
	it.skipIf(process.platform === "win32")("runs a skill's script through bash", async () => {
		const results = await call({ script: { tool: "bash", args: { command: "sh skill://review/scripts/hello.sh" } } });
		assert.match(results.get("script") ?? "", /hello from the review script/);
	});

	it("is read-only and refuses paths that leave the skill's directory", async () => {
		const results = await call({
			escape: { tool: "read", args: { path: "skill://tdd/../../../secret.txt" } },
			write: { tool: "write", args: { path: "skill://review/notes.md", content: "x" } },
		});
		assert.match(results.get("escape") ?? "", /points outside the skill's directory/);
		assert.doesNotMatch(results.get("escape") ?? "", /outside the skill\n/);
		assert.match(results.get("write") ?? "", /skill:\/\/ resources are read-only/);
	});

	it("still reads a skill by the absolute path older sessions were given", async () => {
		const results = await call({ legacy: { tool: "read", args: { path: userSkillFile } } });
		assert.match(results.get("legacy") ?? "", /User TDD body/);
	});
});

describe("skill:// selectors that name several skills", () => {
	const skill = (dir: string, scope: "project" | "user"): Skill => ({
		name: "tdd",
		description: "TDD",
		filePath: join(dir, "SKILL.md"),
		baseDir: dir,
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(join(dir, "SKILL.md"), { source: "local", scope }),
	});

	it("refuses a scope shared by two skills and names the URIs that tell them apart", async () => {
		const first = skill(resolve("/work", ".atomic", "skills", "tdd"), "project");
		const second = skill(resolve("/work", ".agents", "skills", "tdd"), "project");
		const router = createSkillRouter(() => buildSkillCatalog([first, second]));

		assert.equal(await router.resolve?.("skill://tdd"), first.filePath);
		assert.equal(await router.resolve?.("skill://tdd@agents/x.md"), join(second.baseDir, "x.md"));
		await assert.rejects(
			async () => router.resolve?.("skill://tdd@project"),
			/skill:\/\/tdd@project names more than one skill\. Use one of: skill:\/\/tdd@atomic, skill:\/\/tdd@agents/,
		);
	});
});
