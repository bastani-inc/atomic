import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import {
	createScriptSandbox,
	python,
	readUntil,
	type ScriptSandbox,
	skillCreatorDir,
} from "../helpers/skill-creator-scripts.js";

// A Python start for the viewer; seconds under load.
const VIEWER_START_MS = 15_000;
const viewerScript = join(skillCreatorDir, "eval-viewer", "generate_review.py");

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

interface Review {
	readonly run_id: string;
	readonly feedback: string;
}

/** An iteration folder with one run per eval, each with a text output, and optionally its saved feedback. */
function iteration(box: ScriptSandbox, name: string, evals: readonly string[], feedback?: readonly Review[]): string {
	const folder = join(box.dir, name);
	for (const id of evals) {
		const outputs = join(folder, id, "with_skill", "outputs");
		mkdirSync(outputs, { recursive: true });
		writeFileSync(join(outputs, "answer.txt"), `answer for ${id}`);
	}
	if (feedback !== undefined) {
		writeFileSync(join(folder, "feedback.json"), JSON.stringify({ reviews: feedback, status: "in_progress" }));
	}
	return folder;
}

function savedReviews(folder: string): Review[] {
	const data = JSON.parse(readFileSync(join(folder, "feedback.json"), "utf8")) as { reviews: Review[] };
	return data.reviews.map(({ run_id, feedback }) => ({ run_id, feedback }));
}

/** Starts the viewer on a free port and returns its URL. */
async function startViewer(box: ScriptSandbox, args: readonly string[]): Promise<string> {
	const viewer = spawnProcess([python ?? "python3", viewerScript, ...args, "--port", "0"], {
		cwd: box.dir,
		env: box.env(),
		stdout: "pipe",
		stderr: "pipe",
	});
	viewers.push(viewer);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			readUntil(viewer.stdout, /URL:\s+(\S+)/u),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("the viewer did not print its URL")), VIEWER_START_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The review page, run as a browser runs it, with its requests going to `server` (none for a static page). */
function openPage(html: string, server?: string) {
	const { window, document } = parseHTML(html);
	const requests: Promise<unknown>[] = [];
	// The feedback box's save waits 800 ms after typing; these tests save by moving to another run instead.
	const context = {
		window,
		document,
		console,
		atob,
		URL,
		Blob,
		globalThis: undefined as unknown,
		setTimeout: () => 0,
		clearTimeout: () => undefined,
		fetch: (path: string, init?: RequestInit) => {
			const request =
				server === undefined
					? Promise.reject(new TypeError("Failed to fetch"))
					: fetch(new URL(path, server), init).then(async (response) => {
							await response.arrayBuffer();
							return response;
						});
			requests.push(request.catch(() => undefined));
			return request;
		},
	};
	context.globalThis = context;
	for (const script of document.querySelectorAll("script")) {
		if (!script.hasAttribute("src")) runInNewContext(script.textContent ?? "", context);
	}
	const textarea = () => document.getElementById("feedback") as unknown as { value: string };
	return {
		document,
		context,
		feedback: () => textarea().value,
		previousFeedback: () => document.getElementById("prev-feedback-text")?.textContent ?? "",
		type(text: string) {
			textarea().value = text;
			document.getElementById("feedback")?.dispatchEvent(new window.Event("input"));
		},
		/** An arrow key outside the feedback box: moves to the previous or next run, saving the current one. */
		press(key: "ArrowLeft" | "ArrowRight") {
			const event = new window.Event("keydown", { bubbles: true });
			Object.defineProperty(event, "key", { value: key });
			document.body.dispatchEvent(event);
		},
		async settled() {
			for (let count = -1; count !== requests.length; ) {
				count = requests.length;
				await Promise.all(requests);
			}
		},
	};
}

async function openServedPage(url: string) {
	return openPage(await (await fetch(url)).text(), url);
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
		const page = await openServedPage(url);
		assert.equal(page.feedback(), html);
		const shown = [...page.document.querySelectorAll(".output-file-content pre")].map((pre) => pre.textContent);
		assert.ok(shown.includes(html), JSON.stringify(shown));
		assert.equal((page.context as { injected?: boolean }).injected, undefined);
		assert.equal(page.document.querySelectorAll("script:not([src])").length, 1);
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
