import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSearchReturn } from "../../../../web-access/web-search-return.js";

import { repoRoot, runIntercomFixture, runWebFixture } from "./lazy-tool-fixtures.js";

interface FetchClassificationFixtureResult {
	failed: { details: { outcome: string; stage: string; failedUrls: number; successful: number } };
	partial: { details: { outcome?: string; successful: number } };
}

function runFetchClassificationFixture(): FetchClassificationFixtureResult {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-fetch-classification-"));
	try {
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(tempDir, "content-tools.ts"), readFileSync(resolve(repoRoot, "packages/web-access/content-tools.ts"), "utf-8"));
		writeFileSync(join(tempDir, "result-renderers.ts"), `export const renderCodeSearchResult = () => undefined; export const renderFetchContentResult = () => undefined; export const renderGetSearchContentResult = () => undefined;
`);
		writeFileSync(join(tempDir, "code-search.ts"), `export async function executeCodeSearch() { return { content: [], details: {} }; }
`);
		writeFileSync(join(tempDir, "extract.ts"), `
export async function fetchAllContent(urls, signal) {
 signal?.throwIfAborted();
 return urls.map((url) => url.startsWith("ok:")
   ? { url, title: url, content: "content", error: null }
   : { url, title: "", content: "", error: "fetch failed" });
}
`);
		writeFileSync(join(tempDir, "storage.ts"), `
export const generateId = () => "response-id";
export const getResult = () => undefined;
export const storeResult = () => {};
`);
		const moduleUrl = pathToFileURL(join(tempDir, "content-tools.ts")).href;
		const script = `
const { registerContentTools } = await import(${JSON.stringify(moduleUrl)});
const tools = [];
const pi = { registerTool(tool) { tools.push(tool); }, appendEntry() {} };
registerContentTools(pi, { maxInlineContent: 1000, stripThumbnails: (items) => items, formatFullResults: () => "" });
const tool = tools.find((candidate) => candidate.name === "fetch_content");
const signal = new AbortController().signal;
const failed = await tool.execute("failed", { urls: ["bad:one", "bad:two"] }, signal);
const partial = await tool.execute("partial", { urls: ["ok:one", "bad:two"] }, signal);
console.log(JSON.stringify({ failed: { isError: failed.isError, details: failed.details }, partial: { isError: partial.isError, details: partial.details } }));
`;
		const result = spawnSync("bun", ["--eval", script], { cwd: repoRoot, encoding: "utf-8", timeout: 10_000 });
		expect(result.status, result.stderr || result.stdout).toBe(0);
		return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as FetchClassificationFixtureResult;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("lazy tool initialization hardening (#1704)", () => {
	it("replays a failed web lifecycle before a retry executes either public tool", () => {
		const result = runWebFixture<{ replays: number; tool: string }>(`
let replays = 0;
let cleanups = 0;
export default async function init(pi) {
  pi.on("session_start", async () => { replays += 1; if (replays === 1) throw new Error("replay failed once"); });
  pi.on("session_shutdown", async () => { cleanups += 1; });
  pi.registerTool({ name: "web_search", execute: async () => ({ content: [], details: { replays, cleanups, tool: "search" } }) });
  pi.registerTool({ name: "fetch_content", execute: async () => ({ content: [], details: { replays, cleanups, tool: "fetch" } }) });
}
`, `
const ctx = { sessionManager: { getBranch() { return []; } } };
await emit("session_start", { type: "session_start", reason: "new" }, ctx);
let originalFailure = false;
try { await execute("web_search", "first", { query: "one" }, new AbortController().signal, ctx); } catch (error) {
 originalFailure = String(error).includes("replay failed once");
}
const retried = await execute("fetch_content", "second", { url: "https://example.test" }, new AbortController().signal, ctx);
console.log(JSON.stringify({ ...retried.details, originalFailure }));
`);
		expect(result).toEqual({ replays: 2, cleanups: 1, tool: "fetch", originalFailure: true });
	});

	it("single-flights a later failed web replay before concurrent public tools execute", () => {
		const result = runWebFixture<{ originalFailure: boolean; attempts: number; beforeRelease: number; searchCalls: number; fetchCalls: number }>(`
let treeAttempts = 0;
let releaseRetry;
const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
const executions = [];
export default async function init(pi) {
 pi.on("session_start", async () => {});
 pi.on("session_tree", async () => {
  treeAttempts += 1;
  if (treeAttempts === 1) throw new Error("later tree replay failed once");
  await retryGate;
 });
 pi.registerTool({ name: "web_search", execute: async () => { executions.push("search"); return { content: [], details: {} }; } });
 pi.registerTool({ name: "fetch_content", execute: async () => { executions.push("fetch"); return { content: [], details: {} }; } });
 globalThis.releaseRetry = releaseRetry;
 globalThis.replayState = () => ({ treeAttempts, executions: [...executions] });
}
`, `
const ctx = {};
await emit("session_start", { type: "session_start", reason: "new" }, ctx);
await execute("web_search", "initial", { query: "initial" }, new AbortController().signal, ctx);
let originalFailure = false;
try { await emit("session_tree", { type: "session_tree" }, ctx); }
catch (error) { originalFailure = String(error).includes("later tree replay failed once"); }
const search = execute("web_search", "search", { query: "retry" }, new AbortController().signal, ctx);
const fetch = execute("fetch_content", "fetch", { url: "https://example.test" }, new AbortController().signal, ctx);
await waitForGate("second web replay attempt", () => globalThis.replayState().treeAttempts >= 2);
const beforeRelease = globalThis.replayState().executions.length;
globalThis.releaseRetry();
await Promise.all([search, fetch]);
const state = globalThis.replayState();
console.log(JSON.stringify({
 originalFailure, attempts: state.treeAttempts, beforeRelease,
 searchCalls: state.executions.filter((name) => name === "search").length,
 fetchCalls: state.executions.filter((name) => name === "fetch").length,
}));
`);
		expect(result).toEqual({ originalFailure: true, attempts: 2, beforeRelease: 1, searchCalls: 2, fetchCalls: 1 });
	});

	it("waits for the newest generation before publishing a web candidate", () => {
		const result = runWebFixture<{ beforeLatest: boolean; seen: string[] }>(`
let releaseStart;
const startGate = new Promise((resolve) => { releaseStart = resolve; });
let releaseTree;
const treeGate = new Promise((resolve) => { releaseTree = resolve; });
const seen = [];
export default async function init(pi) {
 pi.on("session_start", async () => { seen.push("start"); await startGate; });
 pi.on("session_tree", async () => { seen.push("tree"); await treeGate; });
 pi.registerTool({ name: "web_search", execute: async () => ({ content: [], details: { seen: [...seen] } }) });
 globalThis.releaseStart = releaseStart; globalThis.releaseTree = releaseTree;
}
`, `
const ctx = {};
await emit("session_start", { type: "session_start", reason: "new" }, ctx);
let settled = false;
const pending = execute("web_search", "call", { query: "one" }, new AbortController().signal, ctx).then((value) => { settled = true; return value; });
await waitForGate("web start/tree replay gates", () => typeof globalThis.releaseStart === "function" && typeof globalThis.releaseTree === "function");
const tree = emit("session_tree", { type: "session_tree" }, ctx);
globalThis.releaseStart();
await new Promise((resolve) => setTimeout(resolve, 0));
const beforeLatest = settled;
globalThis.releaseTree();
await tree;
const completed = await pending;
console.log(JSON.stringify({ beforeLatest, seen: completed.details.seen }));
`);
		expect(result).toEqual({ beforeLatest: false, seen: ["start", "tree"] });
	});

	it("rejects a web candidate invalidated by shutdown and replays cleanup", () => {
		const result = runWebFixture<{ rejected: boolean; cleanups: number; executions: number }>(`
let release;
const gate = new Promise((resolve) => { release = resolve; });
let cleanups = 0;
let executions = 0;
export default async function init(pi) {
 globalThis.releaseReplay = release;
 pi.on("session_start", async () => { await gate; });
 pi.on("session_shutdown", async () => { cleanups += 1; });
 pi.registerTool({ name: "web_search", execute: async () => { executions += 1; return { content: [], details: {} }; } });
 globalThis.state = () => ({ cleanups, executions });
}
`, `
const ctx = {};
await emit("session_start", { type: "session_start", reason: "new" }, ctx);
const pending = execute("web_search", "call", { query: "one" }, new AbortController().signal, ctx);
await waitForGate("web replay gate", () => typeof globalThis.releaseReplay === "function");
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
globalThis.releaseReplay();
await shutdown;
let rejected = false;
try { await pending; } catch (error) { rejected = String(error).includes("invalidated by session shutdown"); }
console.log(JSON.stringify({ rejected, ...globalThis.state() }));
`);
		expect(result).toEqual({ rejected: true, cleanups: 1, executions: 0 });
	});

	it("cancels one web caller promptly while a survivor waits for shared initialization", () => {
		const result = runWebFixture<{ exact: boolean; beforeRelease: boolean; executions: number }>(`
let release;
const gate = new Promise((resolve) => { release = resolve; });
let executions = 0;
export default async function init(pi) {
 globalThis.releaseInit = release;
 await gate;
 pi.registerTool({ name: "web_search", execute: async () => { executions += 1; return { content: [], details: { executions } }; } });
 pi.registerTool({ name: "fetch_content", execute: async () => ({ content: [], details: { executions } }) });
}
`, `
const controller = new AbortController();
const reason = new Error("caller cancelled during lazy load");
const cancelled = execute("web_search", "call", { query: "one" }, controller.signal, {});
const outcome = cancelled.then(() => ({ exact: false }), (error) => ({ exact: error === reason }));
await waitForGate("web initializer gate", () => typeof globalThis.releaseInit === "function");
const survivor = execute("fetch_content", "next", { url: "https://example.test" }, new AbortController().signal, {});
controller.abort(reason);
const early = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
const beforeRelease = early !== null;
globalThis.releaseInit();
const next = await survivor;
console.log(JSON.stringify({ exact: early?.exact === true, beforeRelease, executions: next.details.executions }));
`);
		expect(result).toEqual({ exact: true, beforeRelease: true, executions: 0 });
	});

	it("observes a shared web initializer rejection after its only caller aborts", () => {
		const result = runWebFixture<{ exact: boolean; beforeReject: boolean; unhandled: number }>(`
let rejectInit;
const gate = new Promise((_resolve, reject) => { rejectInit = reject; });
export default async function init() {
 globalThis.rejectInit = rejectInit;
 await gate;
}
`, `
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error));
const controller = new AbortController();
const reason = new Error("caller cancelled before shared failure");
const pending = execute("web_search", "call", { query: "one" }, controller.signal, {});
const outcome = pending.then(() => ({ exact: false }), (error) => ({ exact: error === reason }));
await waitForGate("web initializer rejection gate", () => typeof globalThis.rejectInit === "function");
controller.abort(reason);
const early = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
const beforeReject = early !== null;
globalThis.rejectInit(new Error("late shared initializer failure"));
await new Promise((resolve) => setTimeout(resolve, 25));
console.log(JSON.stringify({ exact: early?.exact === true, beforeReject, unhandled: unhandled.length }));
`);
		expect(result).toEqual({ exact: true, beforeReject: true, unhandled: 0 });
	});

	it("rejects cold web calls after the current session has shut down", () => {
		const result = runWebFixture<{ rejected: boolean; initialized: boolean }>(`
globalThis.webInitialized = true;
export default async function init() {}
`, `
const ctx = {};
await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
let rejected = false;
try { await execute("web_search", "late", { query: "one" }, new AbortController().signal, ctx); }
catch (error) { rejected = String(error).includes("no active session"); }
console.log(JSON.stringify({ rejected, initialized: globalThis.webInitialized === true }));
`);
		expect(result).toEqual({ rejected: true, initialized: false });
	});

	it("marks only all-failed search aggregates as errors with provider-stage diagnostics", () => {
		const make = (errors: Array<string | null>) => buildSearchReturn({
			queryList: errors.map((_, index) => `q${index}`),
			results: errors.map((error, index) => ({ query: `q${index}`, answer: "", results: [], error, provider: "exa" })),
			urls: [], includeContent: false,
		}, { pi: { appendEntry() {} } as never, startBackgroundFetch: () => null });
		const failed = make(["one", "two"]);
		const partial = make([null, "two"]);
		expect(failed.details).toMatchObject({ outcome: "all_failed", stage: "provider_execution", failedQueries: 2 });
		expect(partial.details).not.toHaveProperty("outcome");
	});

	it("marks only all-failed fetch aggregates as errors with fetch-stage diagnostics", () => {
		const result = runFetchClassificationFixture();
		expect(result.failed.details).toMatchObject({ outcome: "all_failed", stage: "fetch", failedUrls: 2, successful: 0 });
		expect(result.partial.details).not.toHaveProperty("outcome");
		expect(result.partial.details).toMatchObject({ successful: 1 });
	});

	it("promotes only all-failed web payloads through the host tool-result middleware", () => {
		const runnerEventsUrl = pathToFileURL(resolve(repoRoot, "packages/coding-agent/src/core/extensions/runner-events.ts")).href;
		const result = runWebFixture<{ search: boolean; fetch: boolean; partial?: boolean }>(`
export default async function init() {}
`, `
const { runToolResultHandlers } = await import(${JSON.stringify(runnerEventsUrl)});
const extension = { path: "web-fixture", handlers };
const run = (event) => runToolResultHandlers([extension], {}, event, () => {});
const base = { type: "tool_result", toolCallId: "call", input: {}, content: [], isError: false };
const searchPatch = await run({ ...base, toolName: "web_search", details: { outcome: "all_failed" } });
const fetchPatch = await run({ ...base, toolName: "fetch_content", details: { outcome: "all_failed" } });
const partialPatch = await run({ ...base, toolName: "web_search", details: { successfulQueries: 1 } });
console.log(JSON.stringify({ search: searchPatch?.isError, fetch: fetchPatch?.isError, partial: partialPatch?.isError }));
`);
		expect(result).toEqual({ search: true, fetch: true });
	});

	it("replays a failed Intercom lifecycle before a retry executes", () => {
		const result = runIntercomFixture<{ replays: number }>(`
let replays = 0;
let cleanups = 0;
export default async function init(pi) {
 pi.on("session_start", async () => { replays += 1; if (replays === 1) throw new Error("intercom replay failed once"); });
 pi.on("session_shutdown", async () => { cleanups += 1; });
 pi.registerTool({ name: "intercom", execute: async () => ({ content: [], details: { replays, cleanups } }) });
}
`, `
await emit("session_start", { type: "session_start", reason: "new" });
let originalFailure = false;
try { await execute("first"); } catch (error) { originalFailure = String(error).includes("intercom replay failed once"); }
const retried = await execute("retry");
console.log(JSON.stringify({ ...retried.details, originalFailure }));
`, false);
		expect(result).toEqual({ replays: 2, cleanups: 1, originalFailure: true });
	});


	it("single-flights a later failed Intercom replay before concurrent public tools execute", () => {
		const result = runIntercomFixture<{ originalFailure: boolean; attempts: number; beforeRelease: number; executions: number; order: string[] }>(`
let startAttempts = 0;
let releaseRetry;
const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
let executions = 0;
const order = [];
export default async function init(pi) {
 pi.on("session_start", async () => {
  startAttempts += 1;
  order.push("session:" + startAttempts);
  if (startAttempts === 2) throw new Error("later Intercom replay failed once");
  if (startAttempts === 3) await retryGate;
 });
 pi.on("turn_start", async () => { order.push("turn"); });
 pi.on("model_select", async () => { order.push("model"); });
 pi.on("agent_start", async () => { order.push("agent"); });
 pi.on("tool_execution_start", async () => { order.push("tool"); });
 pi.registerTool({ name: "intercom", execute: async () => { order.push("execute"); return { content: [], details: { executions: ++executions } }; } });
 globalThis.releaseRetry = releaseRetry;
 globalThis.replayState = () => ({ startAttempts, executions, order: [...order] });
}
`, `
await emit("session_start", { type: "session_start", reason: "new" });
await emit("turn_start", { type: "turn_start" });
await emit("model_select", { type: "model_select" });
await emit("agent_start", { type: "agent_start" });
await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "active" });
await execute("initial");
let originalFailure = false;
try { await emit("session_start", { type: "session_start", reason: "reload" }); }
catch (error) { originalFailure = String(error).includes("later Intercom replay failed once"); }
const first = execute("first");
const second = execute("second");
await waitForGate("third Intercom replay attempt", () => globalThis.replayState().startAttempts >= 3);
const beforeRelease = globalThis.replayState().executions;
globalThis.releaseRetry();
await Promise.all([first, second]);
const state = globalThis.replayState();
console.log(JSON.stringify({ originalFailure, attempts: state.startAttempts, beforeRelease, executions: state.executions, order: state.order }));
`, false);
		expect(result).toEqual({
			originalFailure: true, attempts: 3, beforeRelease: 1, executions: 3,
			order: ["session:1", "turn", "model", "agent", "tool", "execute", "session:2", "session:3", "turn", "model", "agent", "tool", "execute", "execute"],
		});
	});

	it("rejects cold Intercom calls after shutdown without synthesizing a replacement session", () => {
		const result = runIntercomFixture<{ rejected: boolean; initialized: boolean }>(`
globalThis.intercomInitialized = true;
export default async function init() {}
`, `
await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
let rejected = false;
try { await execute("late"); } catch (error) { rejected = String(error).includes("no active session"); }
console.log(JSON.stringify({ rejected, initialized: globalThis.intercomInitialized === true }));
`, false);
		expect(result).toEqual({ rejected: true, initialized: false });
	});

	it("retries failed eager Intercom initialization once for concurrent callers", () => {
		const result = runIntercomFixture<{ attempts: number; same: number; errors: string[] }>(`
let attempts = 0;
export default async function init(pi) {
 attempts += 1;
 if (attempts === 1) throw new Error("eager broker unavailable");
 await new Promise((resolve) => setTimeout(resolve, 20));
 pi.registerTool({ name: "intercom", execute: async () => ({ content: [], details: { attempts } }) });
 pi.on("session_start", async () => {});
}
`, `
await emit("session_start", { type: "session_start", reason: "new" });
await waitForGate("Intercom eager failure diagnostic", () => errors.length > 0);
const [a, b] = await Promise.all([execute("a"), execute("b")]);
console.log(JSON.stringify({ attempts: a.details.attempts, same: b.details.attempts, errors }));
`, true);
		expect(result.attempts).toBe(2);
		expect(result.same).toBe(2);
		expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("eager broker unavailable")]));
	});
});
