import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
const build = mode === "blueprint" ? (await import("@bastani/atomic")).runBlueprintBuild : undefined;
const budget = Number("bad-input");
const warnings = [];
let attempt = 0;
process.on("warning", ({ name, message }) => {
	if (name.startsWith("Timeout")) warnings.push({ attempt, name, message });
});

for (attempt = 1; attempt <= 3; attempt++) {
	// The third call is always native: a build must consume the runtime's once-only warning, not imitate it.
	if (!build || attempt === 3) {
		await new Promise((resolve) => setTimeout(resolve, budget));
	} else {
		const repo = join(root, `repo-${attempt}`);
		mkdirSync(join(repo, ".atomic"), { recursive: true });
		writeFileSync(join(repo, ".atomic", "blueprint.yaml"), "initialize:\n  - run: sleep 30\n");
		const result = await build([{ root: repo, identity: "sample" }], {
			agentDir: join(repo, "agent"),
			storeDir: join(repo, "store"),
			homeDir: repo,
			trusted: () => true,
			environment: process.env,
			platform: "linux",
			stepTimeoutMs: budget,
		});
		assert.equal(result.failures[0]?.error.code, "blueprint-step-timed-out");
	}
	await new Promise((resolve) => setImmediate(resolve));
}
console.log(JSON.stringify(warnings));
