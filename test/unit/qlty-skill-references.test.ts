import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { moduleDir, readText } from "../helpers/runtime.js";

const skillRoot = resolve(moduleDir(import.meta.url), "../../packages/subagents/skills/qlty");

async function read(path: string): Promise<string> {
	return (await readText(resolve(skillRoot, path))).replaceAll("\r\n", "\n");
}

test("the qlty skill verifies a release only with a GitHub CLI that fails on a missing attestation", async () => {
	// gh before 2.67.0 can report success for an archive that has no attestation (docs.qlty.sh integrity verification).
	const skill = await read("SKILL.md");
	assert.match(skill, /`gh` 2\.67\.0 or later, signed in/u);
	const quickstart = await read("references/quickstart.md");
	assert.match(
		quickstart,
		/Use `gh` 2\.67\.0 or later, signed in with `gh auth login`, even for public repositories\./u,
	);
	assert.doesNotMatch(
		quickstart,
		/must be installed\.\n\n\*\*Example \(macOS Apple Silicon\):\*\*\n\n```shell\n# Download the archive/u,
	);
	assert.match(
		quickstart,
		/gh attestation verify "\$ARCHIVE" --owner qltysh &&\n {2}tar -xJf "\$ARCHIVE" -C "\$WORK"; then/u,
	);
});

test("the qlty command reference documents --skip and plugin:rule filters for check and fmt", async () => {
	const commands = await read("references/commands.md");
	const section = (name: string) =>
		commands.slice(commands.indexOf(`## \`${name}\``), commands.indexOf("\n---", commands.indexOf(`## \`${name}\``)));
	assert.match(section("check"), /^\* `--skip <SKIP>` — Don't run these plugins, or don't report these rules/mu);
	assert.match(section("check"), /`eslint:no-unused-vars`/u);
	assert.match(section("fmt"), /^\* `--skip <SKIP>` — Don't run these formatter plugins/mu);
});
