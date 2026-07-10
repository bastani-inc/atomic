import { describe, expect, it } from "vitest";
import { runGateTimeoutFixture, runIntercomFixture, runWebFixture } from "./lazy-tool-fixtures.js";

describe("lazy tool lifecycle leases (#1704 round 2)", () => {
	it("reports a named monotonic deadline when a subprocess gate never opens", () => {
		expect(runGateTimeoutFixture("round-two-gate")).toContain("Timed out waiting for round-two-gate");
	});

	it("replaces a loaded web candidate after shutdown and restart", () => {
		const result = runWebFixture<{ attempts: number; first: number; second: number; shutdowns: number[]; executions: number[] }>(`
let attempts = 0; const shutdowns = []; const executions = [];
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async () => {});
 pi.on("session_shutdown", async () => { shutdowns.push(candidate); });
 pi.registerTool({ name: "web_search", execute: async () => { executions.push(candidate); return { content: [], details: { candidate } }; } });
 globalThis.state = () => ({ attempts, shutdowns: [...shutdowns], executions: [...executions] });
}
`, `
const firstCtx = { name: "first" }; const secondCtx = { name: "second" };
await emit("session_start", { type: "session_start", reason: "new" }, firstCtx);
const first = await execute("web_search", "first", { query: "one" }, new AbortController().signal, firstCtx);
await emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, firstCtx);
await emit("session_start", { type: "session_start", reason: "new" }, secondCtx);
const second = await execute("web_search", "second", { query: "two" }, new AbortController().signal, secondCtx);
console.log(JSON.stringify({ ...globalThis.state(), first: first.details.candidate, second: second.details.candidate }));
`);
		expect(result).toEqual({ attempts: 2, first: 1, second: 2, shutdowns: [1], executions: [1, 2] });
	});

	it("replaces a loaded Intercom candidate after shutdown and restart", () => {
		const result = runIntercomFixture<{ attempts: number; first: number; second: number; shutdowns: number[]; executions: number[] }>(`
let attempts = 0; const shutdowns = []; const executions = [];
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async () => {});
 pi.on("session_shutdown", async () => { shutdowns.push(candidate); });
 pi.registerTool({ name: "intercom", execute: async () => { executions.push(candidate); return { content: [], details: { candidate } }; } });
 globalThis.state = () => ({ attempts, shutdowns: [...shutdowns], executions: [...executions] });
}
`, `
await emit("session_start", { type: "session_start", reason: "new" });
const first = await execute("first");
await emit("session_shutdown", { type: "session_shutdown", reason: "switch" });
await emit("session_start", { type: "session_start", reason: "new" });
const second = await execute("second");
console.log(JSON.stringify({ ...globalThis.state(), first: first.details.candidate, second: second.details.candidate }));
`);
		expect(result).toEqual({ attempts: 2, first: 1, second: 2, shutdowns: [1], executions: [1, 2] });
	});

	it("does not let an in-flight web candidate cross shutdown and restart", () => {
		const result = runWebFixture<{ rejected: boolean; candidate: number; attempts: number; shutdowns: string[] }>(`
let attempts = 0; const shutdowns = []; let release; let blocked = false;
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async (event) => { if (candidate === 1 && !blocked) { blocked = true; globalThis.entered = true; await new Promise((resolve) => { release = resolve; }); } });
 pi.on("session_shutdown", async (event, ctx) => { shutdowns.push(candidate + ":" + event.reason + ":" + ctx.name); });
 pi.registerTool({ name: "web_search", execute: async () => ({ content: [], details: { candidate } }) });
 globalThis.releaseOld = () => release(); globalThis.state = () => ({ attempts, shutdowns: [...shutdowns] });
}
`, `
const oldCtx = { name: "old" }; const nextCtx = { name: "next" };
await emit("session_start", { type: "session_start", reason: "old" }, oldCtx);
const oldCall = execute("web_search", "old", { query: "old" }, new AbortController().signal, oldCtx);
await waitForGate("old web replay", () => globalThis.entered === true);
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, oldCtx);
globalThis.releaseOld(); await shutdown;
await emit("session_start", { type: "session_start", reason: "next" }, nextCtx);
let rejected = false; try { await oldCall; } catch (error) { rejected = String(error).includes("invalidated by session shutdown"); }
const fresh = await execute("web_search", "fresh", { query: "new" }, new AbortController().signal, nextCtx);
console.log(JSON.stringify({ rejected, candidate: fresh.details.candidate, ...globalThis.state() }));
`);
		expect(result).toEqual({ rejected: true, candidate: 2, attempts: 2, shutdowns: ["1:switch:old"] });
	});

	it("does not let an in-flight Intercom candidate cross shutdown and restart", () => {
		const result = runIntercomFixture<{ rejected: boolean; candidate: number; attempts: number; shutdowns: string[] }>(`
let attempts = 0; const shutdowns = []; let release; let blocked = false;
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async () => { if (candidate === 1 && !blocked) { blocked = true; globalThis.entered = true; await new Promise((resolve) => { release = resolve; }); } });
 pi.on("session_shutdown", async (event, ctx) => { shutdowns.push(candidate + ":" + event.reason + ":" + ctx.name); });
 pi.registerTool({ name: "intercom", execute: async () => ({ content: [], details: { candidate } }) });
 globalThis.releaseOld = () => release(); globalThis.state = () => ({ attempts, shutdowns: [...shutdowns] });
}
`, `
const oldCtx = { name: "old" }; const nextCtx = { name: "next" };
await emit("session_start", { type: "session_start", reason: "old" }, oldCtx);
const oldCall = execute("old", oldCtx);
await waitForGate("old Intercom replay", () => globalThis.entered === true);
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, oldCtx);
globalThis.releaseOld(); await shutdown;
await emit("session_start", { type: "session_start", reason: "next" }, nextCtx);
let rejected = false; try { await oldCall; } catch (error) { rejected = String(error).includes("invalidated by session shutdown"); }
const fresh = await execute("fresh", nextCtx);
console.log(JSON.stringify({ rejected, candidate: fresh.details.candidate, ...globalThis.state() }));
`);
		expect(result).toEqual({ rejected: true, candidate: 2, attempts: 2, shutdowns: ["1:switch:old"] });
	});

	it("rejects a loaded web invocation when its replay lease is retired", () => {
		const result = runWebFixture<{ rejected: boolean; candidate: number; attempts: number }>(`
let attempts = 0; let release;
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async () => {});
 pi.on("session_tree", async () => { if (candidate === 1) { globalThis.entered = true; await new Promise((resolve) => { release = resolve; }); } });
 pi.on("session_shutdown", async () => {});
 pi.registerTool({ name: "web_search", execute: async () => ({ content: [], details: { candidate } }) });
 globalThis.releaseOld = () => release(); globalThis.attempts = () => attempts;
}
`, `
const oldCtx = {}; const nextCtx = {};
await emit("session_start", { type: "session_start", reason: "old" }, oldCtx);
await execute("web_search", "load", { query: "load" }, new AbortController().signal, oldCtx);
const replay = emit("session_tree", { type: "session_tree" }, oldCtx);
await waitForGate("loaded web replay", () => globalThis.entered === true);
const oldCall = execute("web_search", "old", { query: "old" }, new AbortController().signal, oldCtx);
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, oldCtx);
globalThis.releaseOld(); await Promise.allSettled([replay, shutdown]);
await emit("session_start", { type: "session_start", reason: "next" }, nextCtx);
let rejected = false; try { await oldCall; } catch (error) { rejected = String(error).includes("invalidated by session shutdown"); }
const fresh = await execute("web_search", "fresh", { query: "fresh" }, new AbortController().signal, nextCtx);
console.log(JSON.stringify({ rejected, candidate: fresh.details.candidate, attempts: globalThis.attempts() }));
`);
		expect(result).toEqual({ rejected: true, candidate: 2, attempts: 2 });
	});

	it("rejects a loaded Intercom invocation when its replay lease is retired", () => {
		const result = runIntercomFixture<{ rejected: boolean; candidate: number; attempts: number }>(`
let attempts = 0; let release;
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async (event) => { if (candidate === 1 && event.reason === "reload") { globalThis.entered = true; await new Promise((resolve) => { release = resolve; }); } });
 pi.on("session_shutdown", async () => {});
 pi.registerTool({ name: "intercom", execute: async () => ({ content: [], details: { candidate } }) });
 globalThis.releaseOld = () => release(); globalThis.attempts = () => attempts;
}
`, `
await emit("session_start", { type: "session_start", reason: "old" }); await execute("load");
const replay = emit("session_start", { type: "session_start", reason: "reload" });
await waitForGate("loaded Intercom replay", () => globalThis.entered === true);
const oldCall = execute("old");
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" });
globalThis.releaseOld(); await Promise.allSettled([replay, shutdown]);
await emit("session_start", { type: "session_start", reason: "next" });
let rejected = false; try { await oldCall; } catch (error) { rejected = String(error).includes("invalidated by session shutdown"); }
const fresh = await execute("fresh");
console.log(JSON.stringify({ rejected, candidate: fresh.details.candidate, attempts: globalThis.attempts() }));
`);
		expect(result).toEqual({ rejected: true, candidate: 2, attempts: 2 });
	});

	it("keeps replacement web work behind retired replay and shutdown cleanup", () => {
		const result = runWebFixture<{ attempts: number; before: { attempts: number; executions: number[]; settled: boolean }; first: number; fresh: number; after: number; shutdowns: number[]; executions: number[] }>(`
let attempts = 0; const executions = []; const shutdowns = []; let release;
const cleanupGate = new Promise((resolve) => { release = resolve; });
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async () => {});
 pi.on("session_tree", async () => { if (candidate === 1) { globalThis.replayEntered = true; await cleanupGate; } });
 pi.on("session_shutdown", async () => { if (candidate === 1) { globalThis.shutdownEntered = true; await cleanupGate; } shutdowns.push(candidate); });
 pi.registerTool({ name: "web_search", execute: async () => { executions.push(candidate); return { content: [], details: { candidate } }; } });
 globalThis.releaseCleanup = release; globalThis.state = () => ({ attempts, shutdowns: [...shutdowns], executions: [...executions] });
}
`, `
const oldCtx = { name: "old" }; const nextCtx = { name: "next" };
await emit("session_start", { type: "session_start", reason: "old" }, oldCtx);
const first = await execute("web_search", "first", { query: "old" }, new AbortController().signal, oldCtx);
const replay = emit("session_tree", { type: "session_tree" }, oldCtx);
await waitForGate("old web replay cleanup", () => globalThis.replayEntered === true);
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, oldCtx);
await waitForGate("old web shutdown cleanup", () => globalThis.shutdownEntered === true);
const restart = emit("session_start", { type: "session_start", reason: "next" }, nextCtx);
let settled = false;
const replacement = execute("web_search", "fresh", { query: "new" }, new AbortController().signal, nextCtx).then((value) => { settled = true; return value; });
await Bun.sleep(25);
const before = { ...globalThis.state(), settled };
globalThis.releaseCleanup();
await Promise.allSettled([replay, shutdown]); await restart;
const fresh = await replacement;
const after = await execute("web_search", "after", { query: "again" }, new AbortController().signal, nextCtx);
console.log(JSON.stringify({ ...globalThis.state(), before, first: first.details.candidate, fresh: fresh.details.candidate, after: after.details.candidate }));
`);
		expect(result).toEqual({ attempts: 2, before: { attempts: 1, shutdowns: [], executions: [1], settled: false }, first: 1, fresh: 2, after: 2, shutdowns: [1], executions: [1, 2, 2] });
	});

	it("keeps replacement Intercom work behind retired replay and shutdown cleanup", () => {
		const result = runIntercomFixture<{ attempts: number; before: { attempts: number; executions: number[]; settled: boolean }; first: number; fresh: number; after: number; shutdowns: number[]; executions: number[] }>(`
let attempts = 0; const executions = []; const shutdowns = []; let release;
const cleanupGate = new Promise((resolve) => { release = resolve; });
export default async function init(pi) {
 const candidate = ++attempts;
 pi.on("session_start", async (event) => { if (candidate === 1 && event.reason === "reload") { globalThis.replayEntered = true; await cleanupGate; } });
 pi.on("session_shutdown", async () => { if (candidate === 1) { globalThis.shutdownEntered = true; await cleanupGate; } shutdowns.push(candidate); });
 pi.registerTool({ name: "intercom", execute: async () => { executions.push(candidate); return { content: [], details: { candidate } }; } });
 globalThis.releaseCleanup = release; globalThis.state = () => ({ attempts, shutdowns: [...shutdowns], executions: [...executions] });
}
`, `
const oldCtx = { name: "old" }; const nextCtx = { name: "next" };
await emit("session_start", { type: "session_start", reason: "old" }, oldCtx);
const first = await execute("first", oldCtx);
const replay = emit("session_start", { type: "session_start", reason: "reload" }, oldCtx);
await waitForGate("old Intercom replay cleanup", () => globalThis.replayEntered === true);
const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "switch" }, oldCtx);
const restart = emit("session_start", { type: "session_start", reason: "next" }, nextCtx);
let settled = false;
const replacement = execute("fresh", nextCtx).then((value) => { settled = true; return value; });
await Bun.sleep(25);
const before = { ...globalThis.state(), settled };
globalThis.releaseCleanup();
await Promise.allSettled([replay, shutdown]); await restart;
const fresh = await replacement;
const after = await execute("after", nextCtx);
console.log(JSON.stringify({ ...globalThis.state(), before, first: first.details.candidate, fresh: fresh.details.candidate, after: after.details.candidate }));
`);
		expect(result).toEqual({ attempts: 2, before: { attempts: 1, shutdowns: [], executions: [1], settled: false }, first: 1, fresh: 2, after: 2, shutdowns: [1], executions: [1, 2, 2] });
	});


	it("serializes Intercom replay before matching ends and newer model selection", () => {
		const result = runIntercomFixture<{ turn: boolean; agent: boolean; model: string; tools: string[]; order: string[] }>(`
let release; const gate = new Promise((resolve) => { release = resolve; });
const state = { turn: false, agent: false, model: "", tools: new Set(), order: [] };
export default async function init(pi) {
 pi.on("session_start", async (event) => { state.order.push("session:" + event.reason); if (event.reason === "reload") { globalThis.replayEntered = true; await gate; } });
 pi.on("turn_start", async () => { state.turn = true; state.order.push("turn_start"); });
 pi.on("turn_end", async () => { state.turn = false; state.order.push("turn_end"); });
 pi.on("agent_start", async () => { state.agent = true; state.order.push("agent_start"); });
 pi.on("agent_end", async () => { state.agent = false; state.order.push("agent_end"); });
 pi.on("model_select", async (event) => { state.model = event.model; state.order.push("model:" + event.model); });
 pi.on("tool_execution_start", async (event) => { state.tools.add(event.toolCallId); state.order.push("tool_start:" + event.toolCallId); });
 pi.on("tool_execution_end", async (event) => { state.tools.delete(event.toolCallId); state.order.push("tool_end:" + event.toolCallId); });
 pi.registerTool({ name: "intercom", execute: async () => ({ content: [], details: {} }) });
 globalThis.releaseReplay = release;
 globalThis.state = () => ({ turn: state.turn, agent: state.agent, model: state.model, tools: [...state.tools], order: [...state.order] });
}
`, `
await emit("session_start", { type: "session_start", reason: "old" }, ctx); await execute("load", ctx);
await emit("turn_start", { type: "turn_start" }, ctx);
await emit("model_select", { type: "model_select", model: "model-A" }, ctx);
await emit("agent_start", { type: "agent_start" }, ctx);
await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "done" }, ctx);
const replay = emit("session_start", { type: "session_start", reason: "reload" }, ctx);
await waitForGate("blocked Intercom replay", () => globalThis.replayEntered === true);
const endings = [
 emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "done" }, ctx),
 emit("agent_end", { type: "agent_end" }, ctx),
 emit("turn_end", { type: "turn_end" }, ctx),
 emit("model_select", { type: "model_select", model: "model-B" }, ctx),
];
globalThis.releaseReplay(); await Promise.all([replay, ...endings]);
console.log(JSON.stringify(globalThis.state()));
`);
		expect(result.turn).toBe(false);
		expect(result.agent).toBe(false);
		expect(result.model).toBe("model-B");
		expect(result.tools).toEqual([]);
		expect(result.order.indexOf("turn_end")).toBeGreaterThan(result.order.lastIndexOf("turn_start"));
		expect(result.order.indexOf("model:model-B")).toBeGreaterThan(result.order.lastIndexOf("model:model-A"));
	});
	it("quietly ignores a web session tree after shutdown", () => {
		const result = runWebFixture<{ errored: boolean; initialized: boolean }>(`
globalThis.webInitialized = true;
export default async function init() {}
`, `
const ctx = {};
await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
let errored = false;
try { await emit("session_tree", { type: "session_tree" }, ctx); } catch { errored = true; }
console.log(JSON.stringify({ errored, initialized: globalThis.webInitialized === true }));
`);
		expect(result).toEqual({ errored: false, initialized: false });
	});

	it("makes host curator abort authoritative over heavy resolve or rejection while preserving user cancellation", () => {
		const result = runWebFixture<{ resolvedExact: boolean; rejectedExact: boolean; activeFailure: string; success: { status: string }; user: { cancelled: boolean; cancelReason: string } }>(`
const heavyFailure = new Error("heavy curator failure");
export default async function init(pi) {
 pi.registerTool({ name: "web_search", execute: async (_id, input, signal) => {
  if (input.mode === "user") return { content: [], details: { cancelled: true, cancelReason: "user" } };
  if (input.mode === "success") return { content: [], details: { status: "success" } };
  if (input.mode === "activeReject") throw heavyFailure;
  globalThis.curatorReady = (globalThis.curatorReady ?? 0) + 1;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  if (input.mode === "reject") throw heavyFailure;
  return { content: [], details: { cancelled: true, cancelReason: "stale" } };
 } });
}
`, `
const runHostAbort = async (mode, readyCount) => {
 const controller = new AbortController(); const reason = new Error("host stopped " + mode + " curator");
 const pending = execute("web_search", mode, { mode }, controller.signal, {});
 await waitForGate(mode + " curator pending state", () => globalThis.curatorReady === readyCount);
 controller.abort(reason);
 try { await pending; return false; } catch (error) { return error === reason; }
};
const resolvedExact = await runHostAbort("resolve", 1);
const rejectedExact = await runHostAbort("reject", 2);
let activeFailure = "";
try { await execute("web_search", "active-reject", { mode: "activeReject" }, new AbortController().signal, {}); }
catch (error) { activeFailure = error.message; }
const success = await execute("web_search", "success", { mode: "success" }, new AbortController().signal, {});
const user = await execute("web_search", "user", { mode: "user" }, new AbortController().signal, {});
console.log(JSON.stringify({ resolvedExact, rejectedExact, activeFailure, success: success.details, user: user.details }));
`);
		expect(result).toEqual({ resolvedExact: true, rejectedExact: true, activeFailure: "heavy curator failure", success: { status: "success" }, user: { cancelled: true, cancelReason: "user" } });
	});

});
