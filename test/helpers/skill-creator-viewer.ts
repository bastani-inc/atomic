import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { spawnProcess } from "./runtime.js";
import { python, readUntil, type ScriptSandbox, skillCreatorDir } from "./skill-creator-scripts.js";

// A Python start for the viewer; seconds under load.
const VIEWER_START_MS = 15_000;
export const viewerScript = join(skillCreatorDir, "eval-viewer", "generate_review.py");

export interface Review {
	readonly run_id: string;
	readonly feedback: string;
}

/** An iteration folder with one run per eval, each with a text output, and optionally its saved feedback. */
export function iteration(
	box: ScriptSandbox,
	name: string,
	evals: readonly string[],
	feedback?: readonly Review[],
): string {
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

export function savedFeedback(folder: string): { reviews: Review[]; status: string } {
	return JSON.parse(readFileSync(join(folder, "feedback.json"), "utf8")) as { reviews: Review[]; status: string };
}

export function savedReviews(folder: string): Review[] {
	return savedFeedback(folder).reviews.map(({ run_id, feedback }) => ({ run_id, feedback }));
}

/** Starts the viewer on a free port, adds it to `started` for the test to stop, and returns its URL. */
export async function startViewer(
	box: ScriptSandbox,
	args: readonly string[],
	started: ReturnType<typeof spawnProcess>[],
): Promise<string> {
	const viewer = spawnProcess([python ?? "python3", viewerScript, ...args, "--port", "0"], {
		cwd: box.dir,
		env: box.env(),
		stdout: "pipe",
		stderr: "pipe",
	});
	started.push(viewer);
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
export function openPage(html: string, server?: string) {
	const { window, document } = parseHTML(html);
	const requests: Promise<unknown>[] = [];
	// The page's timers (the feedback box saves 800 ms after typing) run only when the test lets that time pass.
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	// What the page downloads (a static page's feedback on Submit).
	const downloads: Blob[] = [];
	// While held, the page's requests wait until the test lets them go, one at a time.
	let holding = false;
	const held: (() => void)[] = [];
	const context = {
		window,
		document,
		console,
		atob,
		URL: {
			createObjectURL: (blob: Blob) => {
				downloads.push(blob);
				return `blob:download-${downloads.length}`;
			},
			revokeObjectURL: () => undefined,
		},
		Blob,
		globalThis: undefined as unknown,
		setTimeout: (callback: () => void) => {
			timers.set(nextTimer, callback);
			return nextTimer++;
		},
		clearTimeout: (id: number) => {
			timers.delete(id);
		},
		fetch: (path: string, init?: RequestInit) => {
			const send = () => {
				const request =
					server === undefined
						? Promise.reject(new TypeError("Failed to fetch"))
						: fetch(new URL(path, server), init).then(async (response) => {
								const body = await response.arrayBuffer();
								return new Response(body, { status: response.status, headers: response.headers });
							});
				requests.push(request.catch(() => undefined));
				return request;
			};
			if (!holding) return send();
			return new Promise<Response>((resolve, reject) => held.push(() => send().then(resolve, reject)));
		},
	};
	context.globalThis = context;
	for (const script of document.querySelectorAll("script")) {
		if (!script.hasAttribute("src")) runInNewContext(script.textContent ?? "", context);
	}
	const textarea = () => document.getElementById("feedback") as unknown as { value: string };
	const text = (id: string) => document.getElementById(id)?.textContent ?? "";
	return {
		document,
		context,
		feedback: () => textarea().value,
		previousFeedback: () => text("prev-feedback-text"),
		status: () => text("feedback-status"),
		/** The page's notices that show, top to bottom. */
		notices: () =>
			[...document.querySelectorAll("#notices .notice")]
				.filter((notice) => !notice.hasAttribute("hidden"))
				.map((notice) => notice.textContent ?? ""),
		downloads: () => downloads,
		doneShown: () => document.getElementById("done-overlay")?.classList.contains("visible") === true,
		type(value: string) {
			textarea().value = value;
			document.getElementById("feedback")?.dispatchEvent(new window.Event("input"));
		},
		/** An arrow key outside the feedback box: moves to the previous or next run, saving the current one. */
		press(key: "ArrowLeft" | "ArrowRight") {
			const event = new window.Event("keydown", { bubbles: true });
			Object.defineProperty(event, "key", { value: key });
			document.body.dispatchEvent(event);
		},
		/** A click on a button: runs its onclick attribute, as a browser does. */
		click(id: string) {
			runInNewContext(document.getElementById(id)?.getAttribute("onclick") ?? "", context);
		},
		/** Lets the time of the page's pending timers pass. */
		elapse() {
			const due = [...timers.values()];
			timers.clear();
			for (const callback of due) callback();
		},
		/** Holds the page's requests from now on, until released. */
		hold() {
			holding = true;
		},
		/** How many requests the page has waiting. */
		waiting: () => held.length,
		/** Lets the oldest waiting request go, and waits for the page to act on its answer. */
		async release() {
			held.shift()?.();
			await this.settled();
		},
		async settled() {
			for (let count = -1; count !== requests.length; ) {
				count = requests.length;
				await Promise.all(requests);
				// The page acts on an answer after reading it, which takes a few turns of the event loop and no I/O.
				for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
	};
}

export async function openServedPage(url: string) {
	return openPage(await (await fetch(url)).text(), url);
}
