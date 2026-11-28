import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";
import { test } from "vitest";
import { parseReleasePayloadPackages } from "../../scripts/release-npm-preflight.js";
import { compileTypeScript } from "../../scripts/tsc-with-timers.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PRIVATE_PACKAGE = "@bastani/atomic-timers";

interface Manifest {
	name: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

test("release packages embed the same deadline timer source without depending on the private workspace (#6807)", () => {
	const workspaces = globSync("packages/*/package.json", { cwd: ROOT });
	for (const path of workspaces) {
		const manifest = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Manifest;
		if (manifest.name === PRIVATE_PACKAGE) assert.equal(manifest.private, true);
		if (manifest.private) continue;
		for (const deps of [
			manifest.dependencies,
			manifest.optionalDependencies,
			manifest.peerDependencies,
			manifest.devDependencies,
		]) {
			assert.equal(deps?.[PRIVATE_PACKAGE], undefined, path);
		}
	}
	assert.ok(
		!parseReleasePayloadPackages(readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8")).includes(
			PRIVATE_PACKAGE,
		),
	);

	const fresh = mkdtempSync(join(tmpdir(), "atomic-timer-emit-"));
	try {
		compileTypeScript(["-p", join(ROOT, "packages/timers/tsconfig.build.json"), "--outDir", fresh]);
		const expected = readFileSync(join(fresh, "index.js"), "utf8").trimEnd();
		for (const workspace of ["ai", "codemode", "coding-agent", "tui"]) {
			const dist = join(ROOT, "packages", workspace, "dist");
			const vendored = "__atomic_timers/index.js";
			const copies = workspace === "ai" ? [vendored, `_modules/${vendored}`] : [vendored];
			for (const path of copies)
				assert.equal(readFileSync(join(dist, path), "utf8").trimEnd(), expected, `${workspace}/${path}`);
			for (const path of globSync("**/*.{js,mjs,cjs,d.ts}", { cwd: dist })) {
				assert.doesNotMatch(
					readFileSync(join(dist, path), "utf8"),
					/["']@bastani\/atomic-timers["']/,
					`${workspace}/${path}`,
				);
			}
		}
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});
