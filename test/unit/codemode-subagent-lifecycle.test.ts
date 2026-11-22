import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { completionNoticeFromDetails } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import registerSubagentExtension, { readSubagentChildRecords } from "../../packages/subagents/src/extension/index.js";

// Only the child's model turn is held. Admission, owner records, session storage and notice delivery run normally.
let release = Promise.withResolvers<void>();
vi.mock("../../packages/subagents/src/runs/foreground/execution.js", async (original) => {
	const api = await original<typeof import("../../packages/subagents/src/runs/foreground/execution.js")>();
	const runSync: typeof api.runSync = (cwd, agents, agent, task, options) =>
		api.runSync(cwd, agents, agent, task, {
			...options,
			testSession: { promptGate: release.promise, output: `completed: ${task}` },
		});
	return { ...api, runSync };
});

async function run(h: Harness, code: string, fails = false) {
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
		...Array.from({ length: 5 }, () => fauxAssistantMessage("Done")),
	]);
	await h.session.prompt("Run the script");
	const message = h.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "codemode");
	assert(message?.role === "toolResult");
	assert.equal(message.isError, fails, getMessageText(message));
	return getMessageText(message);
}

test("a reopened parent rediscovers and resumes a script-launched child from its saved session", async () => {
	const root = await mkdtemp(join(tmpdir(), "script-resume-"));
	const open = (sessionManager: SessionManager) =>
		createHarness({
			cwd: root,
			sessionManager,
			extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
			initialActiveToolNames: ["codemode", "subagent"],
			provider: "script-resume-provider",
		});
	let h: Harness | undefined;
	try {
		release = Promise.withResolvers<void>();
		const manager = await SessionManager.create(root, join(root, "parent"));
		h = await open(manager);
		const receipts = await run(
			h,
			`const {tasks}=await tools.subagent({tasks:[{agent:'worker',task:'first',progress:false},{agent:'worker',task:'queued',progress:false}],group:true,concurrency:1}); return tasks`,
		);
		const [one, two] = JSON.parse(receipts.split("\n").at(-1)!);
		assert.equal(one.state, "admitted");
		assert.equal(two.state, "queued");
		assert.notEqual(one.taskId, two.taskId);
		assert.notEqual(one.intercomTarget, two.intercomTarget);
		const original = await vi.waitFor(
			() => {
				const file = readSubagentChildRecords(manager.getEntries()).get(one.childId)?.childSessionFile;
				assert.ok(file, "the first child opened its own session before pause");
				return file;
			},
			{ timeout: 10000 },
		);
		const paused = await run(h, `return await tools.subagent({action:'pause',all:true})`);
		assert.deepEqual(
			JSON.parse(paused.split("\n").at(-1)!)
				.children.map((c: { childId: string }) => c.childId)
				.sort(),
			[one.childId, two.childId].sort(),
		);
		const file = manager.getSessionFile();
		assert.ok(file);
		await h.cleanup();
		h = undefined;
		h = await open(await SessionManager.open(file));
		const status = await run(h, `return await tools.subagent({action:'status'})`);
		const children = JSON.parse(status.split("\n").at(-1)!).children;
		assert.deepEqual(
			children.map((c: { state: string }) => c.state),
			["awaiting-resume", "awaiting-resume"],
		);
		const target = children.find((c: { childId: string }) => c.childId === one.childId);
		assert.equal(target.resumable, true);
		const resumed = await run(
			h,
			`return (await tools.subagent({...${JSON.stringify(target.resumeCall)},message:'continue the saved review'})).children[0]`,
		);
		const child = JSON.parse(resumed.split("\n").at(-1)!);
		assert.equal(child.childId, one.childId);
		assert.equal(child.intercomTarget, one.intercomTarget);
		assert.notEqual(child.taskId, one.taskId);
		release.resolve();
		const done = await run(
			h,
			`return (await tools.subagent({action:'wait',id:${JSON.stringify(child.taskId)}})).result`,
		);
		assert.equal(JSON.parse(done.split("\n").at(-1)!).status, "completed");
		const saved = await SessionManager.open(original);
		const prompts = saved
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);
		assert.ok(
			prompts.some((prompt) => prompt.includes("first")),
			"the resumed session kept the original task",
		);
		assert.ok(prompts.includes("continue the saved review"), prompts.join("\n"));
	} finally {
		release.resolve();
		await h?.cleanup();
		await rm(root, { recursive: true, force: true });
	}
});

test("a script can quit its batch without affecting a different parent's child", async () => {
	const session = () =>
		createHarness({
			extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
			initialActiveToolNames: ["codemode", "subagent"],
		});
	release = Promise.withResolvers<void>();
	const a = await session(),
		b = await session();
	try {
		const launch = `return (await tools.subagent({agent:'worker',task:'owned',progress:false})).tasks[0]`;
		const first = JSON.parse((await run(a, launch)).split("\n").at(-1)!);
		const second = JSON.parse((await run(b, launch)).split("\n").at(-1)!);
		const refused = await run(
			a,
			`return await tools.subagent({action:'quit',id:${JSON.stringify(second.childId)}})`,
			true,
		);
		assert.match(refused, /this session launched no such child/i);
		const quit = JSON.parse(
			(await run(a, `return (await tools.subagent({action:'quit',all:true})).children`)).split("\n").at(-1)!,
		);
		assert.deepEqual(
			quit.map((c: { childId: string; state: string }) => [c.childId, c.state]),
			[[first.childId, "quit"]],
		);
		const status = JSON.parse(
			(await run(b, `return (await tools.subagent({action:'status'})).children`)).split("\n").at(-1)!,
		);
		assert.deepEqual(
			status.map((c: { childId: string; state: string }) => [c.childId, c.state]),
			[[second.childId, "running"]],
		);
	} finally {
		release.resolve();
		await Promise.all([a.cleanup(), b.cleanup()]);
	}
});

test("a script that abandons launch during preflight starts no child", async () => {
	const preflight = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const nestedEnded = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			registerSubagentExtension,
			(atomic) => {
				atomic.events.on("subagent:supervisor-authorization", (payload) => {
					(payload as { completion?: Promise<void> }).completion = finish.promise;
					preflight.resolve();
				});
				atomic.on("tool_execution_end", (event) => {
					if (event.toolName === "subagent") nestedEnded.resolve();
				});
				atomic.registerTool({
					name: "entered",
					label: "Entered",
					description: "Observe preflight",
					parameters: Type.Object({}),
					async execute() {
						await preflight.promise;
						return { content: [{ type: "text", text: "entered" }], details: {} };
					},
				});
			},
		],
		initialActiveToolNames: ["codemode", "subagent", "entered"],
	});
	try {
		await run(h, `void tools.subagent({agent:'worker',task:'abandoned'}); return await tools.entered({});`);
		finish.resolve();
		await nestedEnded.promise;
		assert.deepEqual(h.session.getAgentTaskHost().taskRecords(), []);
	} finally {
		finish.resolve();
		preflight.resolve();
		await h.cleanup();
	}
});

test("a script deadline ends its wait, not the child it admitted", async () => {
	release = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const timeout = await run(
			h,
			`// @options: {"timeout_ms": 3000}\nconst {tasks} = await tools.subagent({agent:'worker',task:'survive deadline',progress:false}); await tools.subagent({action:'wait',id:tasks[0].taskId})`,
			true,
		);
		assert.match(timeout, /time(?:d out|out)|deadline/i);
		const snapshot = await run(h, `return (await tools.subagent({action:'status'})).children`);
		const [child] = JSON.parse(snapshot.split("\n").at(-1)!);
		assert.equal(child?.state, "running", snapshot);
		assert.equal(h.session.getAgentTaskHost().hasActiveTaskWaits, false);
		release.resolve();
		await vi.waitFor(
			() =>
				assert(
					h.sessionManager
						.getEntries()
						.some(
							(e) =>
								e.type === "custom_message" &&
								e.customType === "task-completion" &&
								getMessageText(e).includes("completed: survive deadline"),
						),
				),
			{ timeout: 10000 },
		);
	} finally {
		release.resolve();
		await h.cleanup();
	}
});

test("a finished child's notice and its wait results name the call that resumes it", async () => {
	release = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const launched = await run(
			h,
			`return (await tools.subagent({agent:'worker',task:'answer once',context:'fresh',progress:false})).tasks[0]`,
		);
		const child = JSON.parse(launched.split("\n").at(-1)!);
		assert.ok(child.childId && child.intercomTarget, launched);
		const call = `subagent({ action: "resume", id: "${child.childId}", message: "…" })`;
		release.resolve();
		const notice = await vi.waitFor(
			() => {
				const entry = h.sessionManager
					.getEntries()
					.find(
						(e) =>
							e.type === "custom_message" &&
							e.customType === "task-completion" &&
							getMessageText(e).includes("completed: answer once"),
					);
				assert.ok(entry?.type === "custom_message");
				return entry;
			},
			{ timeout: 10000 },
		);
		const text = getMessageText(notice);
		assert.ok(text.includes(`Resume it with ${call} to continue it with a follow-up.`), text);
		assert.ok(text.includes(`Once resumed, it takes Intercom messages again as ${child.intercomTarget}.`), text);
		assert.equal(completionNoticeFromDetails(notice.details)?.resumeId, child.childId);

		const waited = await run(h, `return await tools.subagent({action:'wait',id:${JSON.stringify(child.taskId)}})`);
		const settled = JSON.parse(waited.split("\n").at(-1)!);
		assert.equal(settled.outcome, "settled");
		assert.equal(settled.childId, child.childId);
		assert.deepEqual(settled.resumeCall, { action: "resume", id: child.childId });

		// The model's own wait names the same call in the settled output's header.
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { action: "wait", id: child.taskId }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt("Wait for it");
		const direct = h.session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "subagent");
		assert(direct?.role === "toolResult");
		assert.match(
			getMessageText(direct),
			new RegExp(
				`\\nOutput of ${child.taskId} \\(completed, \\d+ bytes\\): Resume it with ${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to continue it with a follow-up\\.\\n`,
			),
		);
	} finally {
		release.resolve();
		await h.cleanup();
	}
});

test("a child finishes and notifies its parent after its launching script throws", async () => {
	release = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const failure = await run(
			h,
			`const launch = await tools.subagent({agent:'worker',task:'keep working',context:'fresh',progress:false}); throw new Error('admitted '+launch.tasks[0].taskId);`,
			true,
		);
		const [, id] = /admitted (task-[\w-]+)/.exec(failure) ?? [];
		assert.ok(id, failure);
		const observed = await run(h, `return await tools.subagent({action:'wait',id:${JSON.stringify(id)},budgetMs:0})`);
		assert.deepEqual(JSON.parse(observed.split("\n").at(-1)!), { action: "wait", taskId: id, outcome: "running" });
		release.resolve();
		await vi.waitFor(
			() =>
				assert(
					h.sessionManager
						.getEntries()
						.some(
							(entry) =>
								entry.type === "custom_message" &&
								entry.customType === "task-completion" &&
								getMessageText(entry).includes("completed: keep working"),
						),
				),
			{ timeout: 10000 },
		);
		const finished = await run(h, `return (await tools.subagent({action:'wait',id:${JSON.stringify(id)}})).result`);
		assert.deepEqual(JSON.parse(finished.split("\n").at(-1)!), {
			status: "completed",
			output: "completed: keep working",
		});
	} finally {
		release.resolve();
		await h.cleanup();
	}
});
