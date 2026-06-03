#!/usr/bin/env bun
/*
 * Issue #1208 acceptance test: prove that an installed third-party package can
 * type-check `import { defineWorkflow, Type } from "@bastani/workflows"` (and the
 * `@bastani/workflows/builtin/*` composition imports) under `tsc` (NodeNext) with
 * NO hand-authored .d.ts, NO `declare module` shim, and NO tsconfig `paths` alias —
 * using only the externally-resolvable types shipped through @bastani/atomic.
 *
 * It packs the built @bastani/atomic with `bun pm pack`, then materializes throwaway
 * external consumers OUTSIDE the repo (system temp dir), installs the tarball plus a
 * `typebox` peer, and runs `bunx tsc --noEmit` against each, asserting the expected
 * pass/fail. This is the real end-to-end validation for the static-types fix; the
 * runtime workflow loader is unaffected.
 *
 * Usage:
 *   bun run scripts/verify-workflow-sdk-types.ts          # builds, then verifies
 *   SKIP_BUILD=1 bun run scripts/verify-workflow-sdk-types.ts   # reuse current dist
 *   KEEP_FIXTURE=1 bun run scripts/verify-workflow-sdk-types.ts # keep temp dir
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const codingAgentRoot = resolve(import.meta.dir, "..");
const distDir = join(codingAgentRoot, "dist");
const skipBuild = process.env["SKIP_BUILD"] === "1";
const keepFixture = process.env["KEEP_FIXTURE"] === "1";

type Variant = {
	readonly name: string;
	readonly description: string;
	readonly expect: "pass" | "fail";
	readonly mustInclude?: readonly string[];
	readonly files: Readonly<Record<string, string>>;
};

const TARBALL_DEP = "__TARBALL__";

// Workflow file exercising the documented authoring import + a builtin composition import.
const WORKFLOW_FILE = `import { defineWorkflow, Type, type Static } from "@bastani/workflows";
import goal from "@bastani/workflows/builtin/goal";
import { ralph } from "@bastani/workflows/builtin";

const NameSchema = Type.String({ default: "world" });
type Name = Static<typeof NameSchema>;

export default defineWorkflow("hello")
  .input("name", NameSchema)
  .output("greeting", Type.String())
  .run(async (ctx) => {
    const who: Name = ctx.inputs.name;
    await ctx.workflow(goal, { inputs: { objective: \`greet \${who}\` }, stageName: "goal" });
    await ctx.workflow(ralph, { inputs: { prompt: "noop" } });
    return { greeting: \`hello \${who}\` };
  })
  .compile();
`;

function consumerPackageJson(name: string, atomic: object): string {
	return JSON.stringify(
		{
			name,
			version: "1.0.0",
			type: "module",
			private: true,
			atomic,
			dependencies: { "@bastani/atomic": TARBALL_DEP },
			peerDependencies: { "@bastani/atomic": "*", typebox: "^1.1.24" },
			devDependencies: { typebox: "^1.1.24", typescript: "^5.7.3" },
		},
		null,
		2,
	);
}

function tsconfig(extra: object): string {
	return JSON.stringify(
		{
			compilerOptions: {
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				...extra,
			},
			include: ["src/**/*.ts", "workflows/**/*.ts"],
		},
		null,
		2,
	);
}

const VARIANTS: readonly Variant[] = [
	{
		name: "workflow-only-types-optin",
		description: 'Pure workflow-only package; single opt-in via compilerOptions.types ["@bastani/atomic/workflows/ambient"].',
		expect: "pass",
		files: {
			"package.json": consumerPackageJson("wf-types-optin", { workflows: ["./workflows"] }),
			"tsconfig.json": tsconfig({ types: ["@bastani/atomic/workflows/ambient"] }),
			"workflows/hello.ts": WORKFLOW_FILE,
		},
	},
	{
		name: "workflow-only-reference-directive",
		description: 'Pure workflow-only package; single opt-in via /// <reference types="@bastani/atomic/workflows/ambient" />.',
		expect: "pass",
		files: {
			"package.json": consumerPackageJson("wf-reference", { workflows: ["./workflows"] }),
			"tsconfig.json": tsconfig({}),
			"workflows/hello.ts": `/// <reference types="@bastani/atomic/workflows/ambient" />\n${WORKFLOW_FILE}`,
		},
	},
	{
		name: "auto-include-via-atomic-import",
		description: "Package that also imports @bastani/atomic; ambient is auto-included via the root types reference, ZERO tsconfig types entry.",
		expect: "pass",
		files: {
			"package.json": consumerPackageJson("ext-and-workflow", { extensions: ["./src/index.ts"], workflows: ["./workflows"] }),
			"tsconfig.json": tsconfig({}),
			"src/index.ts": `import { VERSION } from "@bastani/atomic";\nexport const myExtensionVersion: string = VERSION;\n`,
			"workflows/hello.ts": WORKFLOW_FILE,
		},
	},
	{
		name: "negative-no-optin",
		description: "Negative control: pure workflow-only package with NO opt-in must fail with TS2307 (the bug this fix closes).",
		expect: "fail",
		mustInclude: ["TS2307", "@bastani/workflows"],
		files: {
			"package.json": consumerPackageJson("wf-no-optin", { workflows: ["./workflows"] }),
			"tsconfig.json": tsconfig({}),
			"workflows/hello.ts": WORKFLOW_FILE,
		},
	},
];

function run(cmd: string, args: string[], cwd: string): { status: number; output: string } {
	const result = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return { status: result.status ?? 1, output };
}

function fail(message: string): never {
	console.error(`\n❌ ${message}`);
	process.exit(1);
}

function main(): void {
	if (!skipBuild) {
		console.log("• Building @bastani/atomic (set SKIP_BUILD=1 to reuse current dist)...");
		const build = run("bun", ["run", "build"], codingAgentRoot);
		if (build.status !== 0) {
			console.error(build.output);
			fail("Build failed.");
		}
	}
	if (!existsSync(join(distDir, "builtin", "workflows", "ambient.d.ts"))) {
		fail("dist/builtin/workflows/ambient.d.ts missing — run `bun --cwd packages/coding-agent run build` first.");
	}

	const workRoot = mkdtempSync(join(tmpdir(), "atomic-wf-types-"));
	console.log(`• Fixture root: ${workRoot}`);

	console.log("• Packing @bastani/atomic with `bun pm pack`...");
	const pack = run("bun", ["pm", "pack", "--destination", workRoot], codingAgentRoot);
	if (pack.status !== 0) {
		console.error(pack.output);
		fail("`bun pm pack` failed.");
	}
	const tarball = readdirSync(workRoot).find((f) => f.endsWith(".tgz"));
	if (!tarball) fail("No .tgz produced by `bun pm pack`.");
	const tarballPath = join(workRoot, tarball);
	console.log(`• Tarball: ${tarballPath}`);

	let failures = 0;
	for (const variant of VARIANTS) {
		const consumerDir = join(workRoot, variant.name);
		for (const [relPath, contents] of Object.entries(variant.files)) {
			const target = join(consumerDir, relPath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents.replace(TARBALL_DEP, `file:${tarballPath}`), "utf-8");
		}
		const install = run("bun", ["install"], consumerDir);
		if (install.status !== 0) {
			console.error(install.output);
			fail(`[${variant.name}] bun install failed.`);
		}
		const tsc = run("bunx", ["tsc", "--noEmit"], consumerDir);
		const passed = tsc.status === 0;
		const expectedPass = variant.expect === "pass";
		let ok = passed === expectedPass;
		if (ok && variant.mustInclude) {
			ok = variant.mustInclude.every((needle) => tsc.output.includes(needle));
		}
		if (ok) {
			console.log(`  ✓ ${variant.name} — ${variant.description} (tsc ${passed ? "passed" : "failed"} as expected)`);
		} else {
			failures += 1;
			console.error(`  ✗ ${variant.name} — expected tsc to ${expectedPass ? "PASS" : "FAIL"} but it ${passed ? "PASSED" : "FAILED"}.`);
			console.error(tsc.output.trim() || "(no tsc output)");
		}
	}

	if (!keepFixture) {
		rmSync(workRoot, { recursive: true, force: true });
	} else {
		console.log(`• KEEP_FIXTURE=1 — left fixtures at ${workRoot}`);
	}

	if (failures > 0) fail(`${failures} workflow SDK type fixture(s) did not match expectations.`);
	console.log("\n✓ All workflow SDK type fixtures matched expectations (issue #1208).");
}

// Surface the package version we are validating against for log context.
const pkgVersion = (JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf-8")) as { version?: string }).version;
console.log(`Verifying externally-resolvable @bastani/workflows types for @bastani/atomic@${pkgVersion ?? "?"}\n`);
main();
