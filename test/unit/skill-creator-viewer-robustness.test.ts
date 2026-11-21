import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, type spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import { createScriptSandbox, python, type ScriptSandbox, skillCreatorDir } from "../helpers/skill-creator-scripts.js";
import {
	iteration,
	openServedPage,
	savedFeedback,
	savedReviews,
	startViewer as startViewerFor,
	viewerScript,
} from "../helpers/skill-creator-viewer.js";

const windows = process.platform === "win32";
// package_skill reads SKILL.md's frontmatter with PyYAML.
const pyyaml = python !== undefined && spawnSyncCollect([python, "-c", "import yaml"]).exitCode === 0;

const sandboxes: ScriptSandbox[] = [];
const viewers: ReturnType<typeof spawnProcess>[] = [];
afterEach(async () => {
	for (const viewer of viewers.splice(0)) {
		viewer.kill("SIGTERM");
		await viewer.exited;
	}
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-robust-");
	sandboxes.push(created);
	return created;
}

function startViewer(box: ScriptSandbox, args: readonly string[]): Promise<string> {
	return startViewerFor(box, args, viewers);
}

/** The copies of feedback.json kept next to it. */
function keptCopies(folder: string): string[] {
	return readdirSync(folder).filter((name) => name.startsWith("feedback.json.corrupt-"));
}

describe.skipIf(python === undefined)("skill-creator review viewer robustness", () => {
	test("a feedback.json that is not JSON is kept as a copy, the page says so and starts empty, and a save replaces it", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		writeFileSync(join(current, "feedback.json"), '{"reviews": [{"run_id": "eval-1-with_skill", "feedb');
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		const [copy] = keptCopies(current);
		assert.ok(copy, "a copy is kept");
		assert.equal(readFileSync(join(current, copy), "utf8"), '{"reviews": [{"run_id": "eval-1-with_skill", "feedb');
		assert.equal(page.notices().length, 1);
		assert.match(page.notices()[0] ?? "", new RegExp(`kept as ${copy}`, "u"));
		assert.equal(page.feedback(), "");
		// Opened again before any save: the same copy, and the same notice.
		const again = await openServedPage(url);
		assert.deepEqual(keptCopies(current), [copy]);
		assert.equal(again.notices().length, 1);
		page.type("the title is missing");
		page.press("ArrowRight");
		await page.settled();
		assert.deepEqual(savedReviews(current), [{ run_id: "eval-1-with_skill", feedback: "the title is missing" }]);
		assert.deepEqual((await openServedPage(url)).notices(), []);
		assert.deepEqual(keptCopies(current), [copy]);
	});

	test.skipIf(windows)("a private feedback.json stays private: its kept copy and the file a save writes", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		writeFileSync(join(current, "feedback.json"), "not JSON");
		chmodSync(join(current, "feedback.json"), 0o600);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		const [copy] = keptCopies(current);
		assert.ok(copy);
		assert.equal(statSync(join(current, copy)).mode & 0o777, 0o600);
		page.type("the title is missing");
		page.press("ArrowRight");
		await page.settled();
		assert.deepEqual(savedReviews(current), [{ run_id: "eval-1-with_skill", feedback: "the title is missing" }]);
		assert.equal(statSync(join(current, "feedback.json")).mode & 0o777, 0o600);
	});

	test("a feedback.json with reviews that cannot be read shows the others, keeps a copy and says so", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		const text = JSON.stringify({ reviews: [{ run_id: "eval-1-with_skill", feedback: "kept" }, { run_id: 5 }] });
		writeFileSync(join(current, "feedback.json"), text);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		assert.equal(page.feedback(), "kept");
		assert.equal(page.notices().length, 1);
		const [copy] = keptCopies(current);
		assert.ok(copy);
		assert.equal(readFileSync(join(current, copy), "utf8"), text);
	});

	test("a feedback.json that cannot be read is never saved over, and the page says a save failed", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		// A folder in its place cannot be read as a file.
		mkdirSync(join(current, "feedback.json", "inside"), { recursive: true });
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		assert.match(page.notices()[0] ?? "", /could not be read .* saves nothing over it/u);
		page.type("the title is missing");
		page.press("ArrowRight");
		await page.settled();
		assert.ok(statSync(join(current, "feedback.json", "inside")).isDirectory());
		assert.deepEqual(keptCopies(current), []);
		assert.ok(
			page.notices().some((notice) => /not saved/iu.test(notice)),
			page.notices().join("\n"),
		);
		assert.notEqual(page.status(), "Saved");
	});

	test("a save made after another tab's save is refused, and that tab says to reload", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		const url = await startViewer(box, [current]);
		const first = await openServedPage(url);
		const second = await openServedPage(url);
		first.type("the title is missing");
		first.press("ArrowRight");
		await first.settled();
		second.press("ArrowRight");
		second.type("add axis labels");
		second.press("ArrowLeft");
		await second.settled();
		assert.deepEqual(savedReviews(current), [{ run_id: "eval-1-with_skill", feedback: "the title is missing" }]);
		assert.ok(
			second.notices().some((notice) => /reload/u.test(notice)),
			second.notices().join("\n"),
		);
		assert.equal(second.status(), "Not saved");
		// Reloaded, it shows the other tab's feedback, and saves again.
		const reloaded = await openServedPage(url);
		assert.equal(reloaded.feedback(), "the title is missing");
		reloaded.press("ArrowRight");
		reloaded.type("add axis labels");
		reloaded.press("ArrowLeft");
		await reloaded.settled();
		assert.deepEqual(savedReviews(current), [
			{ run_id: "eval-1-with_skill", feedback: "the title is missing" },
			{ run_id: "eval-2-with_skill", feedback: "add axis labels" },
		]);
	});

	test("one tab's saves land in order and never refuse each other, however fast they follow", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		page.type("first");
		page.press("ArrowRight");
		page.type("second");
		page.press("ArrowLeft");
		page.type("first, changed");
		page.press("ArrowRight");
		await page.settled();
		assert.deepEqual(savedReviews(current), [
			{ run_id: "eval-1-with_skill", feedback: "first, changed" },
			{ run_id: "eval-2-with_skill", feedback: "second" },
		]);
		assert.deepEqual(page.notices(), []);
		assert.equal(page.status(), "Saved");
	});

	test("Submit while the box waits to save leaves the reviews complete", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		page.type("the title is missing");
		page.click("done-btn");
		await page.settled();
		// The box's save would have come 800 ms after the key.
		page.elapse();
		await page.settled();
		assert.ok(page.doneShown());
		const saved = savedFeedback(current);
		assert.equal(saved.status, "complete");
		assert.deepEqual(
			saved.reviews.map(({ run_id, feedback }) => ({ run_id, feedback })),
			[
				{ run_id: "eval-1-with_skill", feedback: "the title is missing" },
				{ run_id: "eval-2-with_skill", feedback: "" },
			],
		);
	});

	test("unreadable files of a previous iteration and of the runs show as such instead of failing the viewer", async () => {
		const box = sandbox();
		const previous = iteration(box, "iteration-1", ["eval-1"]);
		writeFileSync(join(previous, "feedback.json"), "[1, 2]");
		const current = iteration(box, "iteration-2", ["eval-1"]);
		writeFileSync(join(current, "eval-1", "with_skill", "eval_metadata.json"), "[]");
		writeFileSync(join(current, "eval-1", "with_skill", "grading.json"), Buffer.from([0x81, 0x7b]));
		const url = await startViewer(box, [current, "--previous-workspace", previous]);
		const page = await openServedPage(url);
		assert.match(page.notices()[0] ?? "", /previous iteration's feedback could not be read/u);
		assert.equal(page.feedback(), "");
		assert.equal(
			readFileSync(join(previous, "feedback.json"), "utf8"),
			"[1, 2]",
			"the previous file is never written",
		);
		assert.deepEqual(keptCopies(previous), []);
	});

	test("the viewer run with its output captured in place, as by runpy, reports its errors", () => {
		const box = sandbox();
		const program = [
			"import contextlib, io, runpy, sys",
			"sys.argv = [sys.argv[1], sys.argv[2]]",
			"with contextlib.redirect_stdout(io.StringIO()):",
			"    try:",
			"        runpy.run_path(sys.argv[0], run_name='__main__')",
			"    except SystemExit as exit:",
			"        sys.stderr.write(f'exit {exit.code}')",
		].join("\n");
		const missing = join(box.dir, "missing");
		const result = spawnSyncCollect([python ?? "python3", "-c", program, viewerScript, missing], {
			cwd: box.dir,
			env: box.env(),
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stderr.toString().replaceAll("\r\n", "\n"), `Error: ${missing} is not a directory\nexit 1`);
	});
});

describe.skipIf(!pyyaml)("skill-creator's package_skill", () => {
	function packageSkill(box: ScriptSandbox, output: string) {
		return spawnSyncCollect(
			[python ?? "python3", join(skillCreatorDir, "scripts", "package_skill.py"), box.skill, output],
			{
				cwd: box.dir,
				env: box.env(),
			},
		);
	}

	test.skipIf(windows || process.getuid?.() === 0)(
		"a package that fails leaves an earlier .skill file as it was and no partial file",
		() => {
			const box = sandbox();
			const output = join(box.dir, "dist");
			mkdirSync(output);
			// An earlier package of the skill.
			const before = Buffer.from("an earlier archive");
			writeFileSync(join(output, "skill.skill"), before);
			const unreadable = join(box.skill, "notes.md");
			writeFileSync(unreadable, "notes");
			chmodSync(unreadable, 0o000);
			try {
				const result = packageSkill(box, output);
				assert.equal(result.exitCode, 1, result.stdout.toString());
			} finally {
				chmodSync(unreadable, 0o644);
			}
			assert.deepEqual(readdirSync(output), ["skill.skill"]);
			assert.deepEqual(readFileSync(join(output, "skill.skill")), before);
		},
	);

	test.skipIf(windows)(
		"a new .skill file gets the permissions of a new file, and a replaced one keeps its own",
		() => {
			const box = sandbox();
			const output = join(box.dir, "dist");
			assert.equal(packageSkill(box, output).exitCode, 0);
			const umask = process.umask();
			assert.equal(statSync(join(output, "skill.skill")).mode & 0o777, 0o666 & ~umask);
			chmodSync(join(output, "skill.skill"), 0o640);
			assert.equal(packageSkill(box, output).exitCode, 0);
			assert.equal(statSync(join(output, "skill.skill")).mode & 0o777, 0o640);
		},
	);

	test("a .skill file written inside the skill folder does not contain itself", () => {
		const box = sandbox();
		const output = join(box.skill, "dist");
		assert.equal(packageSkill(box, output).exitCode, 0);
		assert.equal(packageSkill(box, output).exitCode, 0, "packaged again, over the earlier file");
		const listing = spawnSyncCollect(
			[
				python ?? "python3",
				"-c",
				"import sys, zipfile\nprint('\\n'.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))",
				join(output, "skill.skill"),
			],
			{ cwd: box.dir, env: box.env() },
		);
		assert.deepEqual(listing.stdout.toString().trim().split(/\r?\n/u), ["skill/SKILL.md"]);
		assert.deepEqual(readdirSync(output), ["skill.skill"]);
	});
});
