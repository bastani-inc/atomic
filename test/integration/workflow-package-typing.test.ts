import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const repoRoot = resolve(import.meta.dir, "../..");
const workflowsPackage = join(repoRoot, "packages", "workflows");

describe("standalone workflow package typing", () => {
  test("type-checks import { defineWorkflow, Type } from @bastani/workflows without a local shim", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-types-${randomUUID()}`);

    try {
      mkdirSync(join(fixtureRoot, "src"), { recursive: true });
      mkdirSync(join(fixtureRoot, "node_modules", "@bastani"), { recursive: true });
      symlinkSync(workflowsPackage, join(fixtureRoot, "node_modules", "@bastani", "workflows"), "dir");

      writeFileSync(
        join(fixtureRoot, "package.json"),
        JSON.stringify(
          {
            name: "standalone-workflow-typing-fixture",
            private: true,
            type: "module",
            dependencies: {
              "@bastani/workflows": "file:../../packages/workflows",
            },
            devDependencies: {
              typescript: "^6.0.3",
            },
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(fixtureRoot, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              skipLibCheck: false,
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(fixtureRoot, "src", "workflow.ts"),
        `import {
  GraphFrontierTracker,
  createCancellationRegistry,
  createStore,
  defineWorkflow,
  run,
  Type,
} from "@bastani/workflows";
import type { AgentSessionAdapter, StageAdapters } from "@bastani/workflows";

const workflow = defineWorkflow("Standalone Typing Fixture")
  .description("Verifies package export types without declare module shims")
  .input("message", Type.String())
  .input("mode", Type.Literal("fast", { default: "fast" }))
  .input("count", Type.Number({ default: 1 }))
  .input("enabled", Type.Boolean({ default: true }))
  .input("nickname", Type.Optional(Type.String()))
  .output("summary", Type.String())
  .output("maybe", Type.Optional(Type.String()))
  .run(async (ctx) => {
    const message: string = ctx.inputs.message;
    const mode: "fast" = ctx.inputs.mode;
    const count: number = ctx.inputs.count;
    const enabled: boolean = ctx.inputs.enabled;
    const nickname: string | undefined = ctx.inputs.nickname;
    // @ts-expect-error optional input is not a definite string.
    const requiredNickname: string = ctx.inputs.nickname;
    await ctx.task("echo", { prompt: message, output: "echo.md" });
    const chained = await ctx.chain([
      { name: "first", prompt: message },
      { name: "second", prompt: String(count) },
      { name: "third", prompt: mode },
      { name: "fourth", prompt: String(enabled) },
    ]);
    return { summary: chained.at(-1)?.text ?? "", maybe: nickname };
  })
  .compile();

const optionalOutputWorkflow = defineWorkflow("Optional Output Fixture")
  .output("maybe", Type.Optional(Type.String()))
  .run(() => ({}))
  .compile();

const undeclaredOutputWorkflow = defineWorkflow("Undeclared Output Fixture")
  // @ts-expect-error run outputs must be declared before returning them.
  .run(() => ({ summary: "not declared" }))
  .compile();

run(workflow, { message: "hello" }, { executionMode: "non_interactive" });
run(workflow, { message: "hello", mode: "fast", count: 2, enabled: false }, { executionMode: "interactive" });
// @ts-expect-error detached is not a runtime executionMode literal.
run(workflow, { message: "hello" }, { executionMode: "detached" });
// @ts-expect-error message has no default and remains required.
run(workflow, {});

run(optionalOutputWorkflow, {});
const frontier = new GraphFrontierTracker();
const store = createStore();
const cancellationRegistry = createCancellationRegistry();
const adapter: AgentSessionAdapter | undefined = undefined;
const adapters: StageAdapters = { agentSession: adapter };
void undeclaredOutputWorkflow;
void frontier;
void store;
void cancellationRegistry;
void adapters;

export default workflow;
`,
      );

      const options: ExecFileSyncOptionsWithStringEncoding = {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8",
      };
      try {
        execFileSync("bun", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", fixtureRoot], options);
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        assert.fail([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n"));
      }

      assert.ok(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
