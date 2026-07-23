import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quarantineResultFile } from "../../packages/subagents/src/runs/background/result-quarantine.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("quarantine retries exclusive destination collisions without overwriting evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-quarantine-collision-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const source = path.join(resultsDir, ".claims", "collision", "result.json");
	const quarantineDir = path.join(resultsDir, ".undelivered");
	fs.mkdirSync(path.dirname(source), { recursive: true });
	fs.mkdirSync(quarantineDir, { recursive: true });
	fs.writeFileSync(source, "new evidence");
	const contentHash = createHash("sha256").update("new evidence").digest("hex").slice(0, 20);
	const existing = path.join(quarantineDir, `result-collision-${contentHash}.json`);
	fs.writeFileSync(existing, "old evidence");
	const destination = quarantineResultFile(resultsDir, "result.json", source, fs, () => "unique");
	assert.equal(path.basename(destination), `result-unique-${contentHash}.json`);
	assert.equal(fs.readFileSync(existing, "utf-8"), "old evidence");
	assert.equal(fs.readFileSync(destination, "utf-8"), "new evidence");
	assert.equal(fs.existsSync(source), false);
});

test("quarantine retains multiple aliases independently", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-result-quarantine-aliases-"));
	roots.push(root);
	const resultsDir = path.join(root, "results");
	const sources = [path.join(root, "alias-a.json"), path.join(root, "alias-b.json")];
	fs.mkdirSync(resultsDir);
	fs.writeFileSync(sources[0], "a");
	fs.writeFileSync(sources[1], "b");
	const first = quarantineResultFile(resultsDir, "same.json", sources[0]!, fs, () => "one");
	const second = quarantineResultFile(resultsDir, "same.json", sources[1]!, fs, () => "two");
	assert.notEqual(first, second);
	assert.deepEqual([fs.readFileSync(first, "utf-8"), fs.readFileSync(second, "utf-8")], ["a", "b"]);
});
