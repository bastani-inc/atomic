import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.js";

describe.skipIf(process.platform === "win32")("bash internal URL safety", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "atomic-url-"));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("runs quoted mentions unchanged through either commandPrefix path (#4252)", async () => {
		const bash = createBashToolDefinition(cwd, { commandPrefix: "printf prefix:" });
		for (const args of [
			{ command: "printf '%s' 'local://x;uname;#'", cwd },
			{ command: "cd . && printf '%s' 'local://x;uname;#'" },
		]) {
			const result = await bash.execute("quoted", args);
			assert.deepEqual(result.content, [{ type: "text", text: "prefix:local://x;uname;#" }]);
		}
	});

	it.each([
		['printf %s "artifact://path"', "artifact://path"],
		["printf %s $(printf %s artifact://path)", "artifact://path"],
		["printf %s `printf %s artifact://path`", "artifact://path"],
		["printf %s \\artifact://path", "artifact://path"],
		["cat <<EOF\nartifact://path\nEOF", "artifact://path\n"],
		["cat <<'EOF'\nartifact://path\nEOF", "artifact://path\n"],
		["cat <<-EOF\n\tartifact://path\nEOF", "artifact://path\n"],
		["cat <<A <<B\nartifact://path\nA\nbody\nB", "body\n"],
		["printf %s x # artifact://path", "x"],
	])("leaves a scheme inside shell context unchanged: %s (#4252)", async (command, output) => {
		const bash = createBashToolDefinition(cwd);
		const hazard = join(cwd, "$(printf injected)`printf injected`' space");
		const result = await bash.execute("hazard", { command }, undefined, undefined, {
			resolveInternalUrl: () => hazard,
		});
		assert.deepEqual(result.content, [{ type: "text", text: output }]);
	});

	it("lets quoted text mention a scheme while still expanding a plain-word URL (#4252)", async () => {
		const bash = createBashToolDefinition(cwd);
		const path = join(cwd, "notes file.txt");
		const result = await bash.execute(
			"mixed",
			{ command: 'printf "%s|" "see \\`local://x\\` and skill://y"; printf %s local://notes' },
			undefined,
			undefined,
			{ resolveInternalUrl: (url) => (url === "local://notes" ? path : undefined) },
		);
		assert.deepEqual(result.content, [{ type: "text", text: `see \`local://x\` and skill://y|${path}` }]);
	});

	it("leaves a URL beside a brace expansion unchanged but expands one inside a brace group (#4252)", async () => {
		const bash = createBashToolDefinition(cwd);
		const path = join(cwd, "notes.txt");
		const resolveInternalUrl = (url: string) => (url.startsWith("local://") ? path : undefined);
		const expansion = await bash.execute(
			"brace-expansion",
			{ command: "printf '%s|' {a,local://notes.txt}" },
			undefined,
			undefined,
			{ resolveInternalUrl },
		);
		assert.deepEqual(expansion.content, [{ type: "text", text: "a|local://notes.txt|" }]);
		const group = await bash.execute(
			"brace-group",
			{ command: "{ printf '%s|' local://notes.txt ; }" },
			undefined,
			undefined,
			{ resolveInternalUrl },
		);
		assert.deepEqual(group.content, [{ type: "text", text: `${path}|` }]);
	});

	it("treats removed schemes as ordinary text in plain words (#4252)", async () => {
		const bash = createBashToolDefinition(cwd);
		const result = await bash.execute(
			"removed",
			{ command: "printf '%s|' omp://x memory://y agent://z skill://w" },
			undefined,
			undefined,
			{ resolveInternalUrl: () => join(cwd, "resolved") },
		);
		assert.deepEqual(result.content, [
			{ type: "text", text: `omp://x|memory://y|agent://z|${join(cwd, "resolved")}|` },
		]);
	});

	it("keeps bare URL paths literal through both prefix paths", async () => {
		const bash = createBashToolDefinition(cwd, { commandPrefix: "printf prefix:" });
		const path = join(cwd, "odd ' space ; $(printf injected)`printf injected`");
		for (const args of [
			{ command: "printf %s artifact://path", cwd },
			{ command: "cd . && printf %s artifact://path" },
		]) {
			const result = await bash.execute("bare", args, undefined, undefined, { resolveInternalUrl: () => path });
			assert.deepEqual(result.content, [{ type: "text", text: `prefix:${path}` }]);
		}
	});

	// Code scanning #195/#196: balanced setup syntax must survive both prefix paths.
	it.each([
		`export VALUE='balanced value'; printf '%s:' "$VALUE"`,
		`VALUE="$(printf 'balanced value')"; printf '%s:' "$VALUE"`,
		`f() { printf 'balanced value:'; }\nf`,
		`VALUE=$(cat <<'EOF'\nbalanced value\nEOF\n)\nprintf '%s:' "$VALUE"`,
	])("preserves balanced prefix syntax with bare URLs: %s", async (commandPrefix) => {
		const bash = createBashToolDefinition(cwd, { commandPrefix });
		const path = join(cwd, "odd ' ‘ ’ ‚ ‛ space ; $(printf injected)`printf injected`\nline");
		for (const args of [
			{ command: "printf %s artifact://path", cwd },
			{ command: "cd . && printf %s artifact://path" },
		]) {
			const result = await bash.execute("balanced", args, undefined, undefined, { resolveInternalUrl: () => path });
			assert.deepEqual(result.content, [{ type: "text", text: `balanced value:${path}` }]);
		}
	});

	// Code scanning #197 starts at process.cwd(), not the intentional command input.
	it("keeps a metacharacter-bearing cwd and structured environment values literal", async () => {
		const path = join(cwd, "odd ' ; $(touch injected)`touch injected` space");
		await mkdir(path);
		const bash = createBashToolDefinition(path);
		const bare = await bash.execute("bare-cwd", { command: "printf %s local://notes" });
		assert.deepEqual(bare.content, [{ type: "text", text: join(path, "notes") }]);
		const structured = await bash.execute("structured", {
			command: `printf '%s\\n%s' "$PWD" "$VALUE"`,
			cwd: path,
			env: { VALUE: "local://notes" },
		});
		assert.deepEqual(structured.content, [{ type: "text", text: `${await realpath(path)}\n${join(path, "notes")}` }]);
		assert.equal(existsSync(join(path, "injected")), false);
		assert.equal(existsSync(join(cwd, "injected")), false);
	});

	it("preserves arbitrary shell syntax without resolved URLs", async () => {
		const bash = createBashToolDefinition(cwd, { commandPrefix: "VALUE=prefix; export VALUE" });
		const result = await bash.execute("ordinary", { command: 'printf "%s:" "$VALUE"; printf abc | tr a-z A-Z' });
		assert.deepEqual(result.content, [{ type: "text", text: "prefix:ABC" }]);
	});
});
