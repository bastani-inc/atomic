import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { WORKTREE_REPLY_WAIT_MS } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT } from "../../packages/subagents/src/runs/foreground/subagent-run-control.js";
import * as worktrees from "../../packages/subagents/src/runs/shared/worktree.js";
import {
	cleanups,
	gitOutput,
	type Harness,
	harness,
	initGitRepository,
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
	launchWorktreeRun,
	RECORD_WAIT_MS,
	resumedTaskId,
	runCleanups,
	savedPatches,
	settled,
	text,
	waitForWorktreeCleanup,
} from "./subagents-run-control-helpers.js";

afterEach(runCleanups);

test("a clean paused worktree child's worktree is removed when its session closes, and resume recreates it from the run's base (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const base = gitOutput(h.cwd, ["rev-parse", "HEAD"]);
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", Promise.withResolvers<void>());
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	await h.closeOwnerAndReopen("session-close");
	await waitForWorktreeCleanup(h, childA);
	await waitForWorktreeCleanup(h, childB);
	assert.equal(existsSync(childA.cwd), false, "the clean paused child's worktree is removed");
	assert.equal(existsSync(childB.cwd), false, "the clean interrupted sibling's worktree is removed");

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(existsSync(childA.cwd), true, "resume recreated the worktree");
	assert.equal(gitOutput(childA.cwd, ["rev-parse", "HEAD"]), base, "it is recreated at the run's base");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the recreated worktree is removed once the resumed child finished");
});

test("a dirty paused worktree child's worktree is kept when its session closes, and resume continues in it (#3760 run control)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", Promise.withResolvers<void>());
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	const draft = join(childA.cwd, "draft.md");
	writeFileSync(draft, "draft by A\n");

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	await h.closeOwnerAndReopen("session-close");
	await waitForWorktreeCleanup(h, childB);
	assert.equal(existsSync(childB.cwd), false, "the clean sibling's worktree is removed");
	assert.equal(readFileSync(draft, "utf8"), "draft by A\n", "the paused child's uncommitted work is kept");

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(readFileSync(draft, "utf8"), "draft by A\n", "the resumed child continues in its worktree");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the worktree is removed once the resumed child finished");
});

test("a resume that cannot restart a paused worktree child keeps its dirty worktree, edits, draft and branch (#3784)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const siblingDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
	h.finishOn.set("task-b-marker", siblingDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	const running = await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	const branch = running.worktree?.branch;
	assert.ok(branch, "the child record names its worktree branch");
	const trackedEdit = join(childA.cwd, "seed.txt");
	const untrackedDraft = join(childA.cwd, "draft.md");
	writeFileSync(trackedEdit, "edited by A\n");
	writeFileSync(untrackedDraft, "draft by A\n");

	await h.call({ action: "pause", id: childA.childId });
	await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
	siblingDone.resolve();
	await settled(h, childB.taskId as string);
	await waitForWorktreeCleanup(h, childB);
	assert.equal(existsSync(childB.cwd), false, "the run returned and removed its clean worktree");

	h.agentDefined = false;
	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.equal(resumed.isError, true, text(resumed));
	assert.match(text(resumed), /agent "worker" \(project\) is no longer defined/);
	// Read as it reports, not after a pause: by then it has decided to keep the worktree, and runs nothing in it (#5589).
	assert.equal(readFileSync(trackedEdit, "utf8"), "edited by A\n", "the tracked edit survives the failed resume");
	assert.equal(readFileSync(untrackedDraft, "utf8"), "draft by A\n", "the untracked draft survives the failed resume");
	assert.equal(gitOutput(h.cwd, ["branch", "--list", branch]).replace(/^[*+ ]+/, ""), branch, "its branch survives");
});

const unrestartable = [
	{
		why: "its agent is no longer defined",
		fail: (h: Harness) => {
			h.agentDefined = false;
		},
		reported: /agent "worker" \(project\) is no longer defined/,
	},
	{
		why: "looking up its agent fails",
		fail: (h: Harness) => {
			h.agentDiscoveryError = new Error("agent definitions could not be read");
		},
		reported: /agent definitions could not be read/,
	},
] as const;

for (const { why, fail, reported } of unrestartable)
	test(`a resume that cannot restart a paused worktree child because ${why} reports after cleanup when no sibling holds the clean worktree it recreated (#5589)`, async () => {
		const h = harness();
		initGitRepository(h.cwd);
		const siblingDone = Promise.withResolvers<void>();
		h.finishOn.set("task-a-marker", Promise.withResolvers<void>());
		h.finishOn.set("task-b-marker", siblingDone);
		const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
		assert.ok(childA && childB);
		const diffsDir = childA.worktree?.diffsDir;
		if (diffsDir) cleanups.push(async () => rmSync(diffsDir, { recursive: true, force: true }));
		const running = await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
		const branch = running.worktree?.branch;
		assert.ok(branch, "the child record names its worktree branch");

		await h.call({ action: "pause", id: childA.childId });
		await h.waitForLatest(childA.childId, (candidate) => candidate.terminalStatus === "paused");
		siblingDone.resolve();
		await settled(h, childB.taskId as string);
		await waitForWorktreeCleanup(h, childA);
		assert.equal(existsSync(childA.cwd), false, "the run removed the paused child's clean worktree");

		fail(h);
		const resumed = await h.call({ action: "resume", id: childA.childId });
		assert.equal(resumed.isError, true, text(resumed));
		assert.match(text(resumed), reported);
		assert.equal(existsSync(childA.cwd), false, "the worktree resume recreated is removed before it reports");
		assert.equal(gitOutput(h.cwd, ["branch", "--list", branch]), "", "so is the branch it recreated");
	});

test("a failed resume explains why a running sibling keeps the batch worktrees (#5589)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const sibling = Promise.withResolvers<void>();
	h.finishOn.set("pause-this", Promise.withResolvers<void>());
	h.finishOn.set("hold-batch", sibling);
	const [a, b] = await launchWorktreeRun(h, ["pause-this", "hold-batch"]);
	assert.ok(a && b?.taskId);
	try {
		await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
		await h.call({ action: "pause", id: a.childId });
		h.agentDefined = false;
		const failed = await h.call({ action: "resume", id: a.childId });
		assert.equal(failed.isError, true);
		assert.match(text(failed), /agent "worker" .*no longer defined/);
		assert.match(text(failed), /worktree kept until the other children in this batch finish/i);
		assert.equal(existsSync(a.cwd), true);
	} finally {
		sibling.resolve();
		await settled(h, b.taskId);
		await waitForWorktreeCleanup(h, a);
	}
});

test("a failed resume waits for a sibling's sweep that started during its broker acknowledgement (#5589)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const sibling = Promise.withResolvers<void>();
	h.finishOn.set("pause-this", Promise.withResolvers<void>());
	h.finishOn.set("hold-batch", sibling);
	const [a, b] = await launchWorktreeRun(h, ["pause-this", "hold-batch"]);
	assert.ok(a && b?.taskId);
	await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
	await h.call({ action: "pause", id: a.childId });
	const ack = Promise.withResolvers<void>(),
		notified = Promise.withResolvers<void>();
	const events = h.deps.pi.events,
		emit = events.emit.bind(events);
	vi.spyOn(events, "emit").mockImplementation((channel, data) => {
		emit(channel, data);
		if (channel !== SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) return;
		const request = data as SubagentReleaseRestoringChildRequest;
		if (request.gone) {
			request.completion = ack.promise;
			notified.resolve();
		}
	});
	h.agentDefined = false;
	const failed = h.call({ action: "resume", id: a.childId });
	await notified.promise;
	const check = worktrees.worktreeHasUnsavedWork;
	const started = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const spy = vi.spyOn(worktrees, "worktreeHasUnsavedWork").mockImplementation(async (...args) => {
		started.resolve();
		await held.promise;
		return check(...args);
	});
	try {
		sibling.resolve();
		await started.promise;
		ack.resolve();
		setImmediate(held.resolve);
		assert.match(text(await failed), /no longer defined/);
		assert.equal(existsSync(a.cwd), false, "the already-running sweep is finished at reply");
	} finally {
		ack.resolve();
		held.resolve();
		spy.mockRestore();
		await settled(h, b.taskId);
		await waitForWorktreeCleanup(h, a);
	}
});

test(
	"a failed resume bounds a stalled git status, stops its helper, and keeps the worktree (#5589)",
	async () => {
		const h = harness();
		initGitRepository(h.cwd);
		const sibling = Promise.withResolvers<void>();
		h.finishOn.set("pause-this", Promise.withResolvers<void>());
		h.finishOn.set("sibling", sibling);
		const [a, b] = await launchWorktreeRun(h, ["pause-this", "sibling"]);
		assert.ok(a && b?.taskId);
		await h.waitForLatest(a.childId, (record) => !!record.childSessionId);
		const draft = join(a.cwd, "draft.md");
		writeFileSync(draft, "keep this");
		await h.call({ action: "pause", id: a.childId });
		sibling.resolve();
		await settled(h, b.taskId);
		await waitForWorktreeCleanup(h, b);
		const tools = join(h.cwd, ".git", "monitor-test");
		mkdirSync(tools);
		const marker = join(tools, "port"),
			stop = join(tools, "stop");
		const helper = join(tools, "monitor.cjs");
		// The helper's source is fixed; its paths arrive as arguments.
		writeFileSync(
			helper,
			"const fs = require('node:fs'); const [marker, stop] = process.argv.slice(2); const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => fs.writeFileSync(marker, String(s.address().port))); setInterval(() => { if (fs.existsSync(stop)) process.exit(1); }, 40);",
		);
		const monitor = join(tools, "monitor");
		const shellArgs = [process.execPath, helper, marker, stop].map((path) => `'${path.replaceAll("\\", "/")}'`);
		writeFileSync(monitor, `#!/bin/sh\nexec ${shellArgs.join(" ")}\n`);
		chmodSync(monitor, 0o755);
		const savedPath = process.env.PATH;
		if (process.platform !== "win32") {
			const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
			const fake = join(tools, "git");
			writeFileSync(
				fake,
				`#!/bin/sh\nif [ "$3" = status ]; then exec '${realGit}' -c core.fsmonitor='${monitor}' "$@"; fi\nexec '${realGit}' "$@"\n`,
			);
			chmodSync(fake, 0o755);
		}
		// Arm only after the worktree is prepared: the blocked command belongs to the failed resume's sweep.
		Object.defineProperty(h, "agentDefined", {
			get() {
				if (process.platform === "win32")
					gitOutput(h.cwd, ["config", "core.fsmonitor", monitor.replaceAll("\\", "/")]);
				else process.env.PATH = `${tools}${delimiter}${savedPath}`;
				return false;
			},
		});
		// A healthy helper never exits on its own. Release it even on the pre-fix failure, so no child is leaked.
		let release: ReturnType<typeof setTimeout> | undefined;
		try {
			const failed = h.call({ action: "resume", id: a.childId });
			await vi.waitFor(() => assert.ok(existsSync(marker)), { timeout: RECORD_WAIT_MS });
			release = setTimeout(() => writeFileSync(stop, "release"), 2 * WORKTREE_REPLY_WAIT_MS);
			const reply = await failed;
			assert.equal(reply.isError, true);
			assert.match(text(reply), /worktree cleanup .*?(timed out|continues in the background)/i);
			const port = Number(readFileSync(marker, "utf8"));
			await vi.waitFor(
				() =>
					new Promise<void>((resolve, reject) => {
						const server = createServer().once("error", reject);
						server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
					}),
				{ timeout: WORKTREE_REPLY_WAIT_MS },
			);
			assert.equal(existsSync(stop), false, "Atomic ended the helper; the test never released it");
			assert.equal(readFileSync(draft, "utf8"), "keep this");
		} finally {
			clearTimeout(release);
			writeFileSync(stop, "release");
			process.env.PATH = savedPath;
			if (process.platform === "win32") gitOutput(h.cwd, ["config", "--unset", "core.fsmonitor"]);
			Object.defineProperty(h, "agentDefined", { value: true, writable: true });
		}
		const resumedSibling = Promise.withResolvers<void>();
		h.finishOn.set("keep running", resumedSibling);
		const task = resumedTaskId(await h.call({ action: "resume", id: b.childId, message: "keep running" }));
		try {
			await h.waitForLatest(b.childId, (record) => record.taskId === task && !!record.childSessionId);
			h.agentDefined = false;
			const again = await h.call({ action: "resume", id: a.childId });
			assert.match(text(again), /worktree kept until the other children in this batch finish\.$/i);
			assert.doesNotMatch(text(again), /timed out/);
		} finally {
			resumedSibling.resolve();
			await settled(h, task);
			await waitForWorktreeCleanup(h, b);
		}
	},
	LAUNCH_QUIT_RESUME_TIMEOUT_MS,
);

for (const resumed of [false, true])
	test(
		`a ${resumed ? "resumed" : "new"} worktree child's cleanup lets a slow but working Git clean filter finish, saves its patch and removes the worktree (#5589)`,
		async () => {
			const h = harness();
			initGitRepository(h.cwd);
			const first = Promise.withResolvers<void>();
			const next = Promise.withResolvers<void>();
			h.finishOn.set("filtered-file", first);
			h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, next);
			const [child] = await launchWorktreeRun(h, ["filtered-file"]);
			assert.ok(child?.taskId && child.worktree?.diffsDir);
			const diffsDir = child.worktree.diffsDir;
			cleanups.push(async () => rmSync(diffsDir, { recursive: true, force: true }));
			try {
				let taskId = child.taskId;
				await h.waitForLatest(child.childId, (record) => !!record.childSessionId);
				if (resumed) {
					first.resolve();
					await settled(h, taskId);
					await waitForWorktreeCleanup(h, child);
					taskId = resumedTaskId(await h.call({ action: "resume", id: child.childId }));
					await h.waitForLatest(child.childId, (record) => record.taskId === taskId && !!record.childSessionId);
				}
				// Git runs the filter with its own shell on every platform. It succeeds, just after the reply budget.
				gitOutput(h.cwd, ["config", "filter.slow.clean", `sleep ${WORKTREE_REPLY_WAIT_MS / 1000 + 1}; cat`]);
				writeFileSync(join(h.cwd, ".git", "info", "attributes"), "*.slow filter=slow\n");
				writeFileSync(join(child.cwd, "result.slow"), "deliverable\n");
				(resumed ? next : first).resolve();
				await settled(h, taskId);
				await vi.waitFor(
					() =>
						assert.ok(
							savedPatches(child).some((patch) => readFileSync(patch, "utf8").includes("+deliverable")),
							"cleanup saves the patch once the filter finishes",
						),
					{ timeout: RECORD_WAIT_MS, interval: 50 },
				);
				await waitForWorktreeCleanup(h, child);
				assert.equal(existsSync(child.cwd), false, "the worktree is removed");
			} finally {
				first.resolve();
				next.resolve();
			}
		},
		LAUNCH_QUIT_RESUME_TIMEOUT_MS,
	);

/**
 * A restored file as Git checks it out on this machine: with `core.autocrlf=true` (Git for Windows' default) the
 * restored text has CRLF line endings, like every other file of the recreated worktree.
 */
function readCheckedOut(file: string): string {
	return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

test("resuming a completed worktree child starts from its saved edits, and no execution's patch overwrites an earlier one (#3784)", async () => {
	const h = harness();
	initGitRepository(h.cwd);
	const firstDone = Promise.withResolvers<void>();
	const resumedDone = Promise.withResolvers<void>();
	h.finishOn.set("task-a-marker", firstDone);
	h.finishOn.set("task-b-marker", firstDone);
	h.finishOn.set(SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, resumedDone);
	const [childA, childB] = await launchWorktreeRun(h, ["task-a-marker", "task-b-marker"]);
	assert.ok(childA && childB);
	const diffsDir = childA.worktree?.diffsDir;
	if (diffsDir) cleanups.push(async () => rmSync(diffsDir, { recursive: true, force: true }));
	await h.waitForLatest(childA.childId, (candidate) => !!candidate.childSessionId);
	await h.waitForLatest(childB.childId, (candidate) => !!candidate.childSessionId);
	writeFileSync(join(childA.cwd, "seed.txt"), "edited by A\n");
	writeFileSync(join(childA.cwd, "draft.md"), "draft by A\n");

	firstDone.resolve();
	await settled(h, childA.taskId as string);
	await settled(h, childB.taskId as string);
	await waitForWorktreeCleanup(h, childA);
	assert.equal(existsSync(childA.cwd), false, "the completed run removed its worktree");
	const [firstPatch] = savedPatches(childA);
	assert.ok(firstPatch, "the first execution's edits were saved as a patch");
	const firstContent = readFileSync(firstPatch, "utf8");
	assert.match(firstContent, /draft by A/);

	const resumed = await h.call({ action: "resume", id: childA.childId });
	assert.notEqual(resumed.isError, true, text(resumed));
	const resumedTask = resumedTaskId(resumed);
	await h.waitForLatest(childA.childId, (candidate) => candidate.taskId === resumedTask && !!candidate.childSessionId);
	assert.equal(readCheckedOut(join(childA.cwd, "seed.txt")), "edited by A\n", "the earlier tracked edit is back");
	assert.equal(readCheckedOut(join(childA.cwd, "draft.md")), "draft by A\n", "the earlier draft is back");
	writeFileSync(join(childA.cwd, "second.md"), "second pass by A\n");

	resumedDone.resolve();
	await settled(h, resumedTask);
	await waitForWorktreeCleanup(h, childA);
	const patches = savedPatches(childA);
	assert.equal(patches.length, 2, `one patch per execution: ${patches.join(", ")}`);
	assert.equal(readFileSync(firstPatch, "utf8"), firstContent, "the first execution's patch is not overwritten");
	const latest = readFileSync(patches.find((patch) => patch !== firstPatch)!, "utf8");
	assert.match(latest, /edited by A/, "the resumed execution's patch keeps the earlier tracked edit");
	assert.match(latest, /draft by A/, "the resumed execution's patch keeps the earlier draft");
	assert.match(latest, /second pass by A/, "the resumed execution's patch has its own edits");
});
