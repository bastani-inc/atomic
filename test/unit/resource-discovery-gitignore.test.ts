import assert from "node:assert/strict";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { collectResourceFiles } from "../../packages/coding-agent/src/core/package-manager-resource-files.ts";
import { loadSkillsFromDir } from "../../packages/coding-agent/src/core/skills.ts";
import { loadSkillsAsync } from "../../packages/coding-agent/src/core/skills-async.ts";
import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function relativePaths(root: string, paths: readonly string[]): string[] {
	return paths.map((path) => relative(root, path).split(sep).join("/")).sort();
}

function skill(name: string): string {
	return `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody\n`;
}

describe("resource discovery applies ignore files as Git does (#5051)", () => {
	test("a nested unanchored pattern matches at any depth below its directory (#5051)", async () => {
		const root = sandbox.path("skills");
		sandbox.write(join(root, "team", ".gitignore"), "drafts\n");
		sandbox.write(join(root, "team", "x", "drafts", "SKILL.md"), skill("drafts"));
		sandbox.write(join(root, "team", "keep", "SKILL.md"), skill("keep"));
		sandbox.write(join(root, "drafts", "SKILL.md"), skill("drafts"));
		const expected = ["drafts/SKILL.md", "team/keep/SKILL.md"];
		const sync = loadSkillsFromDir({ dir: root, source: "test" });
		assert.deepEqual(
			relativePaths(
				root,
				sync.skills.map((loaded) => loaded.filePath),
			),
			expected,
		);
		const async = await loadSkillsAsync({
			cwd: sandbox.root,
			agentDir: sandbox.path("agent"),
			skillPaths: [root],
			includeDefaults: false,
		});
		assert.deepEqual(
			relativePaths(
				root,
				async.candidates.map((loaded) => loaded.filePath),
			),
			expected,
		);
		assert.deepEqual(relativePaths(root, await collectResourceFiles(root, "skills")), expected);
	});

	test("an escaped bang is a literal name, not a negation (#5051)", async () => {
		const root = sandbox.path("prompts");
		sandbox.write(join(root, ".gitignore"), "\\!bang.md\n");
		sandbox.write(join(root, "!bang.md"), "bang\n");
		sandbox.write(join(root, "kept.md"), "kept\n");
		assert.deepEqual(relativePaths(root, await collectResourceFiles(root, "prompts")), ["kept.md"]);
	});

	test.skipIf(process.platform === "win32" || process.platform === "darwin")(
		"rules match case-sensitively where Git does (#5051)",
		async () => {
			const root = sandbox.path("prompts");
			sandbox.write(join(root, ".gitignore"), "old/\n");
			sandbox.write(join(root, "Old", "p.md"), "kept\n");
			sandbox.write(join(root, "old", "p.md"), "dropped\n");
			assert.deepEqual(relativePaths(root, await collectResourceFiles(root, "prompts")), ["Old/p.md"]);
		},
	);
});

/** Deterministic PRNG so a differential failure reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const DIRECTORIES = ["a", "b", "team", "x", "drafts", "Old", "old", "build"];
const FILES = ["p.md", "Draft.md", "draft.md", "!bang.md", "#e.md", "n b.md", "x.md"];
const PATTERNS = [
	"drafts",
	"draft.md",
	"Draft.md ",
	"old/",
	"Old",
	"\\!bang.md",
	"!bang.md",
	"!draft.md",
	"*.md",
	"!p.md",
	"/p.md",
	"x/",
	"x/ ",
	"**/x",
	"a/**/p.md",
	"b/*.md",
	"\\#e.md",
	"#e.md",
	"n\\ b.md",
	"n b.md",
	"!*/",
	"team/",
	"*",
	"!*.md",
	"[A-Z]*.md",
	"build/**",
	"!build/p.md",
];

describe("prompt discovery agrees with git ls-files on random trees (#5051)", () => {
	test("random nested ignore files (#5051)", async () => {
		const random = mulberry32(5051);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
		const disagreements: string[] = [];
		for (let round = 0; round < 40; round++) {
			const root = sandbox.path(`tree-${round}`);
			await sandbox.git(sandbox.root, "init", "-q", root);
			const directories = new Set([""]);
			for (let index = 0; index < 6; index++) {
				const depth = 1 + Math.floor(random() * 3);
				directories.add(Array.from({ length: depth }, () => pick(DIRECTORIES)).join("/"));
			}
			const ignoreFiles: string[] = [];
			for (const directory of directories) {
				for (let index = 0; index < 2; index++) sandbox.write(join(root, directory, pick(FILES)), "x\n");
				if (random() < 0.5) {
					const rules = `${Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(PATTERNS)).join("\n")}\n`;
					sandbox.write(join(root, directory, ".gitignore"), rules);
					ignoreFiles.push(`${directory || "."}: ${JSON.stringify(rules)}`);
				}
			}
			const { stdout } = await runGit(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root });
			const expected = stdout
				.toString("utf8")
				.split("\0")
				.filter((path) => path.endsWith(".md"))
				.sort();
			const actual = relativePaths(root, await collectResourceFiles(root, "prompts"));
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				disagreements.push(`${ignoreFiles.join(" | ")}\n  git ${expected.join(",")}\n  got ${actual.join(",")}`);
			}
		}
		assert.deepEqual(disagreements, []);
	});
});
