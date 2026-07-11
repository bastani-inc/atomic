import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const repoRoot = resolve(__dirname, "../../../../..");
const subprocessTimeoutMs = 10_000;
const waitForGateSource = `
async function waitForGate(label, predicate, timeoutMs = 2000, intervalMs = 5) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Timed out waiting for " + label);
    await Bun.sleep(Math.min(intervalMs, remaining));
  }
}
`;

function parseFixtureResult<T>(result: ReturnType<typeof spawnSync>): T {
	if (result.status !== 0) {
		const diagnostic = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
		throw new Error(diagnostic || `Fixture subprocess exited with status ${String(result.status)}`);
	}
	return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1) ?? "{}") as T;
}

export function createRepositoryFixtureDir(name: string): string {
	const fixtureRoot = resolve(repoRoot, ".atomic-test-fixtures");
	mkdirSync(fixtureRoot, { recursive: true });
	return mkdtempSync(join(fixtureRoot, `${name}-`));
}

export function runWebFixture<T>(heavySource: string, scriptBody: string): T {
	const tempDir = createRepositoryFixtureDir("web-lazy-hardening");
	try {
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(tempDir, "index.ts"), readFileSync(resolve(repoRoot, "packages/web-access/index.ts"), "utf-8"));
		writeFileSync(join(tempDir, "lifecycle-lease.ts"), readFileSync(resolve(repoRoot, "packages/web-access/lifecycle-lease.ts"), "utf-8"));
		writeFileSync(join(tempDir, "result-renderers.ts"), "export function renderWebAccessToolResult() { return undefined; }\n");
		writeFileSync(join(tempDir, "index-heavy.ts"), heavySource);
		const extensionUrl = pathToFileURL(join(tempDir, "index.ts")).href;
		const script = `
${waitForGateSource}
const { default: webAccess } = await import(${JSON.stringify(extensionUrl)});
const handlers = new Map();
const tools = [];
const pi = {
  registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
  on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); }
};
webAccess(pi);
const emit = async (name, event, ctx) => { let combined; for (const handler of handlers.get(name) ?? []) { const result = await handler(event, ctx); if (result) combined = { ...combined, ...result }; } return combined; };
const tool = (name) => { const found = tools.find((candidate) => candidate.name === name); if (!found) throw new Error(name + " missing"); return found; };
const execute = (name, id, params, signal, ctx) => tool(name).execute(id, params, signal, undefined, ctx);
${scriptBody}
`;
		return parseFixtureResult<T>(spawnSync("bun", ["--eval", script], {
			cwd: repoRoot, encoding: "utf-8", timeout: subprocessTimeoutMs,
		}));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function intercomFixtureEnv(eager: boolean): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	delete env.PI_SUBAGENT_ORCHESTRATOR_TARGET;
	if (eager) env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = "parent";
	return env;
}

export function runIntercomFixture<T>(heavySource: string, scriptBody: string, eager = false): T {
	const tempDir = createRepositoryFixtureDir("intercom-lazy-hardening");
	try {
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(tempDir, "index.ts"), readFileSync(resolve(repoRoot, "packages/intercom/index.ts"), "utf-8"));
		writeFileSync(join(tempDir, "config.ts"), readFileSync(resolve(repoRoot, "packages/intercom/config.ts"), "utf-8"));
		writeFileSync(join(tempDir, "lifecycle-lease.ts"), readFileSync(resolve(repoRoot, "packages/intercom/lifecycle-lease.ts"), "utf-8"));
		writeFileSync(join(tempDir, "lazy-tool-execution.ts"), readFileSync(resolve(repoRoot, "packages/intercom/lazy-tool-execution.ts"), "utf-8"));
		writeFileSync(join(tempDir, "lazy-subagent-ack.ts"), readFileSync(resolve(repoRoot, "packages/intercom/lazy-subagent-ack.ts"), "utf-8"));
		writeFileSync(join(tempDir, "lazy-heavy-proxy.ts"), readFileSync(resolve(repoRoot, "packages/intercom/lazy-heavy-proxy.ts"), "utf-8"));
		writeFileSync(join(tempDir, "result-renderers.ts"), "export function renderIntercomToolResult() { return undefined; }\n");
		writeFileSync(join(tempDir, "index-heavy.ts"), heavySource);
		const extensionUrl = pathToFileURL(join(tempDir, "index.ts")).href;
		const script = `
${waitForGateSource}
const errors = [];
console.error = (...parts) => errors.push(parts.map(String).join(" "));
const { default: intercom } = await import(${JSON.stringify(extensionUrl)});
const handlers = new Map(); const tools = [];
const pi = {
 registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
 on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
 events: { on() { return () => {}; } }
};
intercom(pi);
const ctx = { cwd: ${JSON.stringify(repoRoot)} };
const emit = async (name, event, eventCtx = ctx) => { for (const handler of handlers.get(name) ?? []) await handler(event, eventCtx); };
const tool = (name) => { const found = tools.find((candidate) => candidate.name === name); if (!found) throw new Error(name + " missing"); return found; };
const execute = (id, callCtx = ctx) => tool("intercom").execute(id, { action: "status" }, new AbortController().signal, undefined, callCtx);
${scriptBody}
`;
		return parseFixtureResult<T>(spawnSync("bun", ["--eval", script], {
			cwd: repoRoot, encoding: "utf-8", timeout: subprocessTimeoutMs, env: intercomFixtureEnv(eager),
		}));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export function runGateTimeoutFixture(label: string): string {
	const script = `${waitForGateSource}\nawait waitForGate(${JSON.stringify(label)}, () => false, 20, 2);`;
	const result = spawnSync("bun", ["--eval", script], {
		cwd: repoRoot, encoding: "utf-8", timeout: subprocessTimeoutMs,
	});
	return [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
}
