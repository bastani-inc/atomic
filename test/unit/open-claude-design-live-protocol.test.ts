import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	buildLiveEventPrompt,
	buildLiveSessionStartPrompt,
	type LiveEvent,
	needsModel,
	parseLiveEvent,
	pollLiveEvent,
	replyLiveEvent,
	replyTokenFor,
	resolveLiveScript,
	type ScriptResult,
} from "../../packages/workflows/builtin/open-claude-design-live-protocol.js";

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** A project whose impeccable skill is installed, so the scripts resolve. */
function makeProjectWithScripts(): string {
	const dir = mkdtempSync(join(tmpdir(), "live-protocol-"));
	dirs.push(dir);
	const scripts = join(dir, ".agents", "skills", "impeccable", "scripts");
	mkdirSync(scripts, { recursive: true });
	const script = join(scripts, "live-poll.mjs");
	writeFileSync(script, "#!/usr/bin/env node\n");
	chmodSync(script, 0o755);
	return dir;
}

/** Scripted stdout for successive poll invocations. */
function fakeRunner(outputs: readonly string[]): {
	run: (script: string, args: readonly string[], cwd: string) => Promise<ScriptResult>;
	calls: { args: readonly string[] }[];
} {
	const calls: { args: readonly string[] }[] = [];
	let index = 0;
	return {
		calls,
		run: async (_script, args) => {
			calls.push({ args });
			const stdout = outputs[Math.min(index, outputs.length - 1)] ?? "";
			index += 1;
			return { code: 0, stdout, stderr: "" };
		},
	};
}

describe("open-claude-design live protocol (workflow-owned poll loop)", () => {
	test("parses the last JSON line the helper printed", () => {
		const event = parseLiveEvent('noise\n{"type":"steer","message":"tighten the hero","id":"e1"}');
		assert.equal(event.type, "steer");
		assert.equal(event.message, "tighten the hero");
		assert.equal(event.id, "e1");
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
	});

	test("the bundled skill resolves from any cwd, and a project copy wins", () => {
		// impeccable ships inside this package, so the live scripts are always
		// present: `packages/workflows/skills/impeccable/scripts` in the repo and
		// `dist/builtin/workflows/skills/impeccable/scripts` once bundled.
		const bundled = resolveLiveScript(mkdtempSync(join(tmpdir(), "live-bare-")), "live-poll.mjs");
		assert.ok(bundled !== undefined, "the bundled skill must resolve without a project copy");
		assert.match(bundled, /skills[/\\]impeccable[/\\]scripts[/\\]live-poll\.mjs$/);

		const vendored = makeProjectWithScripts();
		assert.equal(
			resolveLiveScript(vendored, "live-poll.mjs"),
			join(vendored, ".agents", "skills", "impeccable", "scripts", "live-poll.mjs"),
		);
	});

	test("only generate, steer, and manual_edit_apply call the model back", () => {
		const of = (type: string): LiveEvent => ({ type, raw: "{}" });
		assert.equal(needsModel(of("generate")), true);
		assert.equal(needsModel(of("steer")), true);
		assert.equal(needsModel(of("manual_edit_apply")), true);
		for (const type of ["accept", "discard", "prefetch", "exit", "timeout"]) {
			assert.equal(needsModel(of(type)), false, `${type} must not mint a model stage`);
		}
	});

	test("steer acknowledges with steer_done, everything else with done", () => {
		assert.equal(replyTokenFor({ type: "steer", raw: "{}" }), "steer_done");
		assert.equal(replyTokenFor({ type: "generate", raw: "{}" }), "done");
		assert.equal(replyTokenFor({ type: "manual_edit_apply", raw: "{}" }), "done");
	});

	test("replying passes --reply and the token to the poll script", async () => {
		const dir = makeProjectWithScripts();
		const runner = fakeRunner([""]);

		await replyLiveEvent({ workflowCwd: dir, token: "steer_done", deps: { run: runner.run } });

		assert.deepEqual(runner.calls[0]?.args, ["--reply", "steer_done"]);
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
