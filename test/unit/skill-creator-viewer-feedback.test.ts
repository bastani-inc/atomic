import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, type spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import { createScriptSandbox, python, type ScriptSandbox, skillCreatorDir } from "../helpers/skill-creator-scripts.js";
import {
	iteration,
	openPage,
	openServedPage,
	savedReviews,
	startViewer as startViewerFor,
	viewerScript,
} from "../helpers/skill-creator-viewer.js";

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
	const created = createScriptSandbox("skill-creator-viewer-");
	sandboxes.push(created);
	return created;
}

function startViewer(box: ScriptSandbox, args: readonly string[]): Promise<string> {
	return startViewerFor(box, args, viewers);
}

describe.skipIf(python === undefined)("skill-creator review viewer feedback", () => {
	test("reopened from iteration 2 on, the page shows the feedback saved for its workspace, and the next save keeps it", async () => {
		const box = sandbox();
		const previous = iteration(box, "iteration-1", ["eval-1"], [{ run_id: "eval-1-with_skill", feedback: "older" }]);
		const current = iteration(
			box,
			"iteration-2",
			["eval-1", "eval-2"],
			[{ run_id: "eval-1-with_skill", feedback: "the title is missing" }],
		);
		const url = await startViewer(box, [current, "--previous-workspace", previous]);
		const page = await openServedPage(url);
		assert.equal(page.feedback(), "the title is missing");
		assert.equal(page.previousFeedback(), "older");
		page.press("ArrowRight");
		// Each save lands before the next starts: two saves sent at once can reach the server in either order.
		await page.settled();
		page.type("add axis labels");
		page.press("ArrowLeft");
		await page.settled();
		assert.equal(page.feedback(), "the title is missing");
		assert.deepEqual(savedReviews(current), [
			{ run_id: "eval-1-with_skill", feedback: "the title is missing" },
			{ run_id: "eval-2-with_skill", feedback: "add axis labels" },
		]);
		assert.deepEqual(savedReviews(previous), [{ run_id: "eval-1-with_skill", feedback: "older" }]);
	});

	test("a key press as soon as the page opens saves the feedback already saved with it", async () => {
		const box = sandbox();
		const current = iteration(
			box,
			"iteration-1",
			["eval-1", "eval-2"],
			[{ run_id: "eval-1-with_skill", feedback: "the title is missing" }],
		);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		page.press("ArrowRight");
		await page.settled();
		assert.deepEqual(savedReviews(current), [{ run_id: "eval-1-with_skill", feedback: "the title is missing" }]);
	});

	test("an output or feedback containing </script> shows as written and does not end the page's script", async () => {
		const box = sandbox();
		const html = "<p>a</p></script><script>globalThis.injected = true</script><!-- <script>";
		const current = iteration(box, "iteration-1", ["eval-1"], [{ run_id: "eval-1-with_skill", feedback: html }]);
		writeFileSync(join(current, "eval-1", "with_skill", "outputs", "page.html"), html);
		const url = await startViewer(box, [current]);
		const served = await (await fetch(url)).text();
		// HTML ends a script at "</script", and after "<!--" a "<script" makes the script's own end tag not end it.
		const embedded = /const EMBEDDED_DATA = (.*);/u.exec(served)?.[1] ?? "";
		assert.ok(embedded.includes("globalThis.injected"), "the output is in the page");
		assert.doesNotMatch(embedded, /<\/script|<!--/iu);
		const page = openPage(served, url);
		assert.equal(page.feedback(), html);
		const shown = [...page.document.querySelectorAll(".output-file-content pre")].map((pre) => pre.textContent);
		assert.ok(shown.includes(html), JSON.stringify(shown));
		assert.equal((page.context as { injected?: boolean }).injected, undefined);
		assert.equal(page.document.querySelectorAll("script:not([src])").length, 1);
	});

	test("the served page is never kept in the browser's cache, so a restored or revisited tab gets the saved feedback", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1"]);
		const url = await startViewer(box, [current]);
		const page = await fetch(url);
		await page.arrayBuffer();
		assert.equal(page.headers.get("cache-control"), "no-store");
	});

	test("feedback saved with a UTF-8 byte order mark is shown, and the next save keeps it", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		const reviews = [{ run_id: "eval-1-with_skill", feedback: "caf\u00e9 title" }];
		writeFileSync(
			join(current, "feedback.json"),
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ reviews }))]),
		);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		assert.equal(page.feedback(), "caf\u00e9 title");
		page.press("ArrowRight");
		// Each save lands before the next starts: two saves sent at once can reach the server in either order.
		await page.settled();
		page.type("axis labels");
		page.press("ArrowLeft");
		await page.settled();
		assert.deepEqual(savedReviews(current), [
			{ run_id: "eval-1-with_skill", feedback: "caf\u00e9 title" },
			{ run_id: "eval-2-with_skill", feedback: "axis labels" },
		]);
	});

	test("feedback that is not UTF-8 is shown with replacement marks and kept, as before", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1", "eval-2"]);
		// "caf\u00e9" saved in Windows' code page 1252: 0xE9 is not UTF-8.
		const text = Buffer.from('{"reviews": [{"run_id": "eval-1-with_skill", "feedback": "caf\xe9 title"}]}', "latin1");
		writeFileSync(join(current, "feedback.json"), text);
		const url = await startViewer(box, [current]);
		const page = await openServedPage(url);
		assert.equal(page.feedback(), "caf\ufffd title");
		page.press("ArrowRight");
		// Each save lands before the next starts: two saves sent at once can reach the server in either order.
		await page.settled();
		page.type("axis labels");
		page.press("ArrowLeft");
		await page.settled();
		assert.deepEqual(savedReviews(current), [
			{ run_id: "eval-1-with_skill", feedback: "caf\ufffd title" },
			{ run_id: "eval-2-with_skill", feedback: "axis labels" },
		]);
	});

	test("outputs full of HTML make a page not much larger than they are", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1"]);
		const html = "<p>x</p>".repeat(125_000);
		writeFileSync(join(current, "eval-1", "with_skill", "outputs", "page.html"), html);
		const url = await startViewer(box, [current]);
		const response = await fetch(url);
		const page = await response.text();
		const template = readFileSync(join(skillCreatorDir, "eval-viewer", "viewer.html"), "utf8");
		// Only "</" and "<!" are written escaped: an eighth more for this output, not more than twice its size.
		assert.ok(page.length < template.length + html.length * 1.2, `${page.length} for a ${html.length}-byte output`);
		const opened = openPage(page, url);
		const shown = [...opened.document.querySelectorAll(".output-file-content pre")].map((pre) => pre.textContent);
		assert.ok(shown.includes(html));
	});

	test("a saved feedback file nested too deeply to read starts the page empty instead of failing it", async () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1"]);
		writeFileSync(join(current, "feedback.json"), `${"[".repeat(100_000)}${"]".repeat(100_000)}`);
		const url = await startViewer(box, [current]);
		const response = await fetch(url);
		assert.equal(response.status, 200);
		const page = openPage(await response.text(), url);
		assert.equal(page.feedback(), "");
	});

	test("a static page starts with no feedback, as before", () => {
		const box = sandbox();
		const current = iteration(box, "iteration-1", ["eval-1"], [{ run_id: "eval-1-with_skill", feedback: "saved" }]);
		const output = join(box.dir, "review.html");
		const result = spawnSyncCollect([python ?? "python3", viewerScript, current, "--static", output], {
			cwd: box.dir,
			env: box.env(),
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const page = openPage(readFileSync(output, "utf8"));
		assert.equal(page.feedback(), "");
	});

	test("the previous iteration's feedback is shown as previous, and never saved as this iteration's", async () => {
		const box = sandbox();
		const previous = iteration(box, "iteration-1", ["eval-1"], [{ run_id: "eval-1-with_skill", feedback: "older" }]);
		const current = iteration(box, "iteration-2", ["eval-1", "eval-2"]);
		const url = await startViewer(box, [current, "--previous-workspace", previous]);
		const page = await openServedPage(url);
		assert.equal(page.feedback(), "");
		assert.equal(page.previousFeedback(), "older");
		page.type("better now");
		page.press("ArrowRight");
		await page.settled();
		assert.deepEqual(savedReviews(current), [{ run_id: "eval-1-with_skill", feedback: "better now" }]);
		assert.deepEqual(savedReviews(previous), [{ run_id: "eval-1-with_skill", feedback: "older" }]);
	});
});
