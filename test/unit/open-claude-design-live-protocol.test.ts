import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	buildLiveEventPrompt,
	buildLiveSessionStartPrompt,
	LIVE_POLL_VERB,
	type LiveEvent,
	liveLauncherPath,
	needsModel,
	parseLiveEvent,
	pollLiveEvent,
	replyLiveEvent,
	replyTokenFor,
	type ScriptResult,
} from "../../packages/workflows/builtin/open-claude-design-live-protocol.js";

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** A project whose impeccable skill is installed, so a launcher resolves there too. */
function makeProjectWithScripts(): string {
	const dir = mkdtempSync(join(tmpdir(), "live-protocol-"));
	dirs.push(dir);
	const scripts = join(dir, ".pi", "skills", "impeccable", "scripts");
	mkdirSync(scripts, { recursive: true });
	const launcher = join(scripts, "impeccable");
	writeFileSync(launcher, "#!/bin/sh\n");
	chmodSync(launcher, 0o755);
	return dir;
}

/** Scripted stdout for successive poll invocations. */
function fakeRunner(outputs: readonly string[]): {
	run: (launcher: string, args: readonly string[], cwd: string) => Promise<ScriptResult>;
	calls: { launcher: string; args: readonly string[] }[];
} {
	const calls: { launcher: string; args: readonly string[] }[] = [];
	let index = 0;
	return {
		calls,
		run: async (launcher, args) => {
			calls.push({ launcher, args });
			const stdout = outputs[Math.min(index, outputs.length - 1)] ?? "";
			index += 1;
			return { code: 0, stdout, stderr: "" };
		},
	};
}

describe("open-claude-design live protocol (workflow-owned poll loop)", () => {
	test("parses the last JSON line and retains upstream mount/reply fields", () => {
		const event = parseLiveEvent(
			'noise\n{"type":"variant_mount_failed","id":"e1","variant":2,"url":"/live/v2.js","pageUrl":"/settings","error":"compile failed","file":"src/page.tsx","message":"repair","data":{"status":"error"}}',
		);
		assert.equal(event.type, "variant_mount_failed");
		assert.equal(event.id, "e1");
		assert.equal(event.variant, 2);
		assert.equal(event.url, "/live/v2.js");
		assert.equal(event.pageUrl, "/settings");
		assert.equal(event.error, "compile failed");
		assert.equal(event.file, "src/page.tsx");
		assert.equal(event.message, "repair");
		assert.deepEqual(event.data, { status: "error" });
	});

	test("unreadable output is a timeout, never an ending", () => {
		assert.equal(parseLiveEvent("boom, not json").type, "timeout");
		assert.equal(parseLiveEvent("").type, "timeout");
	});

	test("timeouts are absorbed, so only substantive events reach the workflow", async () => {
		const dir = makeProjectWithScripts();
		const runner = fakeRunner(['{"type":"timeout"}', '{"type":"timeout"}', '{"type":"generate","id":"g1"}']);

		const event = await pollLiveEvent({ workflowCwd: dir, deps: { run: runner.run } });

		assert.equal(event.type, "generate");
		assert.equal(runner.calls.length, 3, "polled through both timeouts");
		for (const call of runner.calls) {
			assert.equal(call.launcher, liveLauncherPath(), "every poll runs the bundled launcher");
			assert.deepEqual(call.args, [LIVE_POLL_VERB], "a poll is the bare live-poll verb");
		}
	});

	test("nonzero poll helper exits fail instead of becoming another timeout", async () => {
		const dir = makeProjectWithScripts();
		await assert.rejects(
			pollLiveEvent({
				workflowCwd: dir,
				deps: {
					run: async () => ({ code: 1, stdout: "", stderr: "server unavailable" }),
				},
			}),
			/server unavailable/u,
		);
	});

	test("always resolves the launcher bundled with this package, never a project copy", () => {
		const resolved = liveLauncherPath();
		assert.match(resolved, /skills[/\\]impeccable[/\\]scripts[/\\]impeccable(?:\.cmd)?$/);
		assert.ok(existsSync(resolved), "the bundled engine launcher must ship with this package");
		assert.match(liveLauncherPath("linux"), /[/\\]impeccable$/);
		assert.match(liveLauncherPath("darwin"), /[/\\]impeccable$/);
		assert.match(liveLauncherPath("win32"), /[/\\]impeccable\.cmd$/, "Windows runs the .cmd launcher");
		assert.ok(existsSync(liveLauncherPath("linux")), "the POSIX launcher must ship");
		assert.ok(existsSync(liveLauncherPath("win32")), "the Windows launcher must ship");

		// A project that vendors its own copy is deliberately ignored: the loop
		// depends on the launcher's verb surface, reply tokens, and event
		// vocabulary, and the bundled copy is the one tested against this code.
		const vendored = makeProjectWithScripts();
		assert.notEqual(liveLauncherPath(), join(vendored, ".pi", "skills", "impeccable", "scripts", "impeccable"));
	});

	test("only model events call the model; mount success stays journal-only", () => {
		const of = (type: string): LiveEvent => ({ type, raw: "{}" });
		assert.equal(needsModel(of("generate")), true);
		assert.equal(needsModel(of("steer")), true);
		assert.equal(needsModel(of("manual_edit_apply")), true);
		assert.equal(needsModel(of("variant_mount_failed")), true);
		assert.equal(needsModel(of("variant_mounted")), false);
		for (const type of ["accept", "discard", "prefetch", "exit", "timeout"]) {
			assert.equal(needsModel(of(type)), false, `${type} must not mint a model stage`);
		}
	});

	test("reply status follows the helper protocol", () => {
		assert.equal(replyTokenFor({ type: "steer", raw: "{}" }), "steer_done");
		assert.equal(replyTokenFor({ type: "generate", raw: "{}" }), "done");
		assert.equal(replyTokenFor({ type: "manual_edit_apply", raw: "{}" }), "done");
		assert.equal(replyTokenFor({ type: "variant_mount_failed", raw: "{}" }), "done");
	});

	test("replying passes event id, status, and only required optional fields", async () => {
		const dir = makeProjectWithScripts();
		const runner = fakeRunner([""]);

		await replyLiveEvent({
			workflowCwd: dir,
			event: { type: "steer", id: "e1", raw: "{}" },
			deps: { run: runner.run },
		});

		assert.equal(runner.calls[0]?.launcher, liveLauncherPath());
		assert.deepEqual(runner.calls[0]?.args, [LIVE_POLL_VERB, "--reply", "e1", "steer_done"]);

		const detailed = fakeRunner([""]);
		await replyLiveEvent({
			workflowCwd: dir,
			event: { type: "manual_edit_apply", id: "m1", raw: "{}" },
			file: "src/page.html",
			message: "applied",
			data: { status: "done", files: ["src/page.html"] },
			deps: { run: detailed.run },
		});
		assert.deepEqual(detailed.calls[0]?.args, [
			LIVE_POLL_VERB,
			"--reply",
			"m1",
			"done",
			"--file",
			"src/page.html",
			"--data",
			'{"status":"done","files":["src/page.html"]}',
			"applied",
		]);
	});

	test("missing event ids and nonzero reply exits fail loudly", async () => {
		const dir = makeProjectWithScripts();
		const runner = fakeRunner([""]);
		await assert.rejects(
			replyLiveEvent({ workflowCwd: dir, event: { type: "generate", raw: "{}" }, deps: { run: runner.run } }),
			/live event id is missing/u,
		);
		await assert.rejects(
			replyLiveEvent({
				workflowCwd: dir,
				event: { type: "generate", id: "g1", raw: "{}" },
				deps: { run: async () => ({ code: 2, stdout: "", stderr: "bad reply" }) },
			}),
			/bad reply/u,
		);
		await assert.rejects(
			replyLiveEvent({
				workflowCwd: dir,
				event: { type: "generate", id: "done", raw: "{}" },
				deps: { run: runner.run },
			}),
			/expected an event id/u,
		);
	});

	test("an event prompt carries the raw event and forbids the stage from polling or exiting", () => {
		const prompt = buildLiveEventPrompt({
			event: { type: "generate", id: "g1", raw: '{"type":"generate","id":"g1"}' },
			previewPath: "/tmp/run/preview.html",
		});
		assert.match(prompt, /"type":"generate"/);
		assert.match(prompt, /three DISTINCT on-brand variants/);
		assert.match(prompt, /Do not poll, do not reply, and do not exit/);
		assert.match(prompt, /\/tmp\/run\/preview\.html/);
	});

	test("the start prompt tells the user how to end a review that otherwise waits forever", () => {
		const prompt = buildLiveSessionStartPrompt({
			previewPath: "/tmp/run/preview.html",
			previewFileUrl: "file:///tmp/run/preview.html",
			browserBootstrapRules: "<rules/>",
			round: 1,
		});
		assert.match(prompt, /how the user ends the review/);
		assert.match(prompt, /close the browser tab/);
		assert.match(prompt, /exit live/);
		assert.match(prompt, /waits indefinitely/);
		assert.match(prompt, /exports the design as it then stands/);
		// The stage opens the session and stops; the workflow owns the loop.
		assert.match(prompt, /Do NOT start a poll loop/);
	});
});
