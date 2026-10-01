import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("removed provider active surfaces", () => {
	test("builtin workflow and subagent model policies contain no removed-provider candidates", () => {
		for (const path of ["packages/workflows/builtin/open-claude-design-runner.ts"]) {
			assert.doesNotMatch(read(path), /cursor\//iu, path);
		}

		const agentsDir = join(root, "packages/subagents/agents");
		for (const name of readdirSync(agentsDir).filter((entry) => entry.endsWith(".md"))) {
			const frontmatter = readFileSync(join(agentsDir, name), "utf8").split("---", 2)[1] ?? "";
			assert.doesNotMatch(frontmatter, /cursor\//iu, name);
		}

		assert.match(
			read("packages/subagents/agents/codebase-pattern-finder.md"),
			/\bpagination\b/u,
			"ordinary pagination terminology must remain intact",
		);
	});

	test("Impeccable ships no removed-editor compatibility adapter", () => {
		const skill = "packages/workflows/skills/impeccable";
		assert.equal(existsSync(join(root, skill, "scripts/hook-before-edit.mjs")), false);
		for (const path of [
			`${skill}/SKILL.md`,
			`${skill}/scripts/impeccable`,
			`${skill}/scripts/impeccable.cmd`,
			`${skill}/scripts/live-browser.js`,
			`${skill}/scripts/live-browser-dom.js`,
			`${skill}/scripts/live-browser-session.js`,
			`${skill}/scripts/live-browser-ignores.js`,
			`${skill}/reference/hooks.md`,
			`${skill}/reference/live.md`,
			`${skill}/reference/live-setup.md`,
			`${skill}/reference/routing.md`,
		]) {
			const content = read(path);
			assert.doesNotMatch(
				content,
				/\bCursor\b|\.cursor(?:\/|\\)|CURSOR_PROJECT_DIR|\bcursor(?:Event|Denials)\b/u,
				path,
			);
			assert.equal(content.includes("hook-before-edit"), false, path);
		}
		assert.match(
			read(`${skill}/reference/overdrive.md`),
			/responds to the cursor/u,
			"ordinary pointer-cursor design guidance must remain intact",
		);
	});

	test("published Atomic dependency metadata omits the removed provider's protobuf runtime", () => {
		const dependency = "@bufbuild/" + "protobuf";
		// bun.lock was deleted when install moved to npm; package-lock.json is now
		// the single verified lockfile and already covered both surfaces.
		for (const path of [
			"packages/coding-agent/package.json",
			"package-lock.json",
			"packages/coding-agent/npm-shrinkwrap.json",
		]) {
			assert.equal(read(path).includes(dependency), false, path);
		}
	});
});
