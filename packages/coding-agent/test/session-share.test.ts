import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { beforeAll, describe, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { Container } from "@bastani/atomic-tui";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ShareProcess = EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	kill: ReturnType<typeof vi.fn>;
};

type ShareContext = {
	session: {
		exportToJsonl: (path: string, options?: object) => Promise<string>;
		sessionManager: { getSessionId(): string };
	};
	ui: { setFocus: () => void; requestRender: () => void };
	editorContainer: Container;
	editor: Container;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

/** The first line of an exported session `id`. */
const header = (id: string) => `${JSON.stringify({ type: "session", id })}\n`;

describe("InteractiveMode /share", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps concurrent session exports isolated", async () => {
		const processes: ShareProcess[] = [];
		const uploadPaths: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
			if (args[0] === "auth") {
				const auth = new EventEmitter();
				setImmediate(() => auth.emit("close", 0));
				return auth;
			}
			uploadPaths.push(args.at(-1)!);
			releaseA();
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			processes.push(child);
			return child;
		});

		const errors: string[] = [];
		const exportOptions: Array<object | undefined> = [];
		let releaseA!: () => void;
		const bUploaded = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const context = (name: "A" | "B"): ShareContext => ({
			session: {
				exportToJsonl: async (path, options) => {
					exportOptions.push(options);
					writeFileSync(path, header(name));
					if (name === "A") await bUploaded;
					return path;
				},
				sessionManager: { getSessionId: () => name },
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: new Container(),
			editor: new Container(),
			showStatus() {},
			showError: (message) => errors.push(message),
		});
		const handleShareCommand = (
			InteractiveMode.prototype as unknown as { handleShareCommand(this: ShareContext): Promise<void> }
		).handleShareCommand;

		const shareA = handleShareCommand.call(context("A"));
		const shareB = handleShareCommand.call(context("B"));

		await vi.waitFor(() => assert.equal(uploadPaths.length, 2));
		assert.notEqual(uploadPaths[0], uploadPaths[1]);
		assert.deepEqual(uploadPaths.map((path) => readFileSync(path, "utf8")).sort(), [header("A"), header("B")]);
		for (const [index, child] of processes.entries()) {
			child.stdout.end(`https://gist.github.com/test/${index + 1}\n`);
			child.stderr.end();
			child.emit("close", 0);
		}
		await Promise.all([shareA, shareB]);
		assert.deepEqual(errors, []);
		assert.deepEqual(exportOptions, [
			{ includeShareContext: true, snapshotContent: false, toolOutputContent: false },
			{ includeShareContext: true, snapshotContent: false, toolOutputContent: false },
		]);
	});

	describe("cancelling and failing (#6077)", () => {
		const ESCAPE = "\x1b";
		type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
		const child = (): Child =>
			Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });

		/** A share whose gh children and export the test drives, on a prompt slot that counts the prompt's returns. */
		function share(exportToJsonl: (path: string) => Promise<string>) {
			const spawned: Array<{ args: string[]; child: Child }> = [];
			childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
				const spawnedChild = child();
				spawned.push({ args, child: spawnedChild });
				return spawnedChild;
			});
			const editor = new Container();
			const editorContainer = new Container();
			editorContainer.addChild(editor);
			let returns = 0;
			const addChild = editorContainer.addChild.bind(editorContainer);
			editorContainer.addChild = (component) => {
				if (component === editor) returns++;
				addChild(component);
			};
			const statuses: string[] = [];
			const errors: string[] = [];
			const context: ShareContext = {
				session: { exportToJsonl: (path) => exportToJsonl(path), sessionManager: { getSessionId: () => "A" } },
				ui: { setFocus() {}, requestRender() {} },
				editorContainer,
				editor,
				showStatus: (message) => statuses.push(message),
				showError: (message) => errors.push(message),
			};
			const handleShareCommand = (
				InteractiveMode.prototype as unknown as { handleShareCommand(this: ShareContext): Promise<void> }
			).handleShareCommand;
			const done = handleShareCommand.call(context);
			const loader = editorContainer.children[0];
			return {
				context,
				done,
				spawned,
				statuses,
				errors,
				loader,
				returns: () => returns,
				showsPrompt: () => editorContainer.children.length === 1 && editorContainer.children[0] === editor,
				cancel: () => {
					assert.ok(loader instanceof BorderedLoader);
					loader.handleInput(ESCAPE);
				},
			};
		}

		it("shows the loader in the prompt's place before gh is asked anything", async () => {
			const run = share(async (path) => path);
			assert.ok(run.loader instanceof BorderedLoader, "the loader is up as the command starts");
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			assert.deepEqual(run.spawned[0]?.args, ["auth", "status"]);
			run.spawned[0]?.child.emit("close", 1);
			await run.done;
			assert.deepEqual(run.errors, ["GitHub CLI is not logged in. Run 'gh auth login' first."]);
			assert.ok(run.showsPrompt());
			assert.equal(run.returns(), 1);
		});

		it("Esc while gh is checked stops it, shows the prompt and runs nothing else", async () => {
			const exported: string[] = [];
			const run = share(async (path) => {
				exported.push(path);
				return path;
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.cancel();
			assert.equal(run.spawned[0]?.child.kill.mock.calls.length, 1);
			assert.ok(run.showsPrompt(), "the prompt is back at once");
			run.spawned[0]?.child.emit("close", null);
			await run.done;
			assert.deepEqual(exported, []);
			assert.equal(run.spawned.length, 1, "no gist is created");
			assert.deepEqual(run.statuses, ["Share cancelled"]);
			assert.deepEqual(run.errors, []);
			assert.equal(run.returns(), 1);
		});

		it("a cancelled gh that keeps running is killed after a grace period", async () => {
			const run = share(async (path) => path);
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			const auth = run.spawned[0]?.child;
			assert.ok(auth);
			Object.assign(auth, { exitCode: null, signalCode: null });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				run.cancel();
				assert.deepEqual(auth.kill.mock.calls, [[]]);
				vi.advanceTimersByTime(1_999);
				assert.deepEqual(auth.kill.mock.calls, [[]], "it gets time to exit");
				vi.advanceTimersByTime(1);
				assert.deepEqual(auth.kill.mock.calls, [[], ["SIGKILL"]]);
			} finally {
				vi.useRealTimers();
			}
			auth.emit("close", null);
			await run.done;
			assert.deepEqual(run.statuses, ["Share cancelled"]);
			assert.equal(run.returns(), 1);
		});

		it("Esc during the export shows the prompt at once and removes the folder once the export ends", async () => {
			const writing = Promise.withResolvers<void>();
			const exporting = Promise.withResolvers<string>();
			const run = share(async (path) => {
				exporting.resolve(path);
				await writing.promise;
				writeFileSync(path, header("A"));
				return path;
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.spawned[0]?.child.emit("close", 0);
			const path = await exporting.promise;
			run.cancel();
			assert.ok(run.showsPrompt(), "the prompt is back at once");
			// Time for a removal started by the cancel to finish, were there one.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.ok(existsSync(dirname(path)), "the folder stays while the export still writes into it");
			writing.resolve();
			await run.done;
			assert.equal(existsSync(dirname(path)), false);
			assert.equal(run.spawned.length, 1, "no gist is created");
			assert.deepEqual(run.statuses, ["Share cancelled"]);
			assert.deepEqual(run.errors, []);
			assert.equal(run.returns(), 1);
		});

		it("Esc while the gist is created stops gh and removes the folder once gh has exited", async () => {
			let exportedPath = "";
			const run = share(async (path) => {
				exportedPath = path;
				writeFileSync(path, header("A"));
				return path;
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.spawned[0]?.child.emit("close", 0);
			await vi.waitFor(() => assert.equal(run.spawned.length, 2));
			const gist = run.spawned[1]?.child;
			assert.ok(gist);
			run.cancel();
			assert.equal(gist.kill.mock.calls.length, 1);
			assert.ok(run.showsPrompt(), "the prompt is back at once");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.ok(existsSync(dirname(exportedPath)), "the folder stays while gh may still read it");
			gist.emit("close", null);
			await run.done;
			assert.equal(existsSync(dirname(exportedPath)), false);
			assert.deepEqual(run.statuses, ["Share cancelled"]);
			assert.deepEqual(run.errors, []);
			assert.equal(run.returns(), 1);
		});

		it("a session replaced while gh is checked is not shared, and neither is its replacement", async () => {
			const exported: string[] = [];
			const run = share(async (path) => {
				exported.push("A");
				return path;
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.context.session = {
				exportToJsonl: async (path) => {
					exported.push("B");
					return path;
				},
				sessionManager: { getSessionId: () => "B" },
			};
			run.spawned[0]?.child.emit("close", 0);
			let finished = false;
			void run.done.then(() => {
				finished = true;
			});
			await vi.waitFor(() => assert.ok(finished || exported.length > 0 || run.spawned.length > 1));
			assert.deepEqual(exported, []);
			assert.equal(run.spawned.length, 1, "no gist is created");
			await run.done;
			assert.deepEqual(run.statuses, ["Share cancelled: the session changed"]);
			assert.deepEqual(run.errors, []);
			assert.ok(run.showsPrompt());
			assert.equal(run.returns(), 1);
		});

		it("a session that another takes the place of in the same view is not shared", async () => {
			let current = "A";
			const exported: string[] = [];
			const run = share(async (path) => {
				exported.push(current);
				return path;
			});
			run.context.session.sessionManager = { getSessionId: () => current };
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			current = "B";
			run.spawned[0]?.child.emit("close", 0);
			let finished = false;
			void run.done.then(() => {
				finished = true;
			});
			await vi.waitFor(() => assert.ok(finished || exported.length > 0 || run.spawned.length > 1));
			assert.deepEqual(exported, []);
			assert.equal(run.spawned.length, 1, "no gist is created");
			await run.done;
			assert.deepEqual(run.statuses, ["Share cancelled: the session changed"]);
		});

		it("a session replaced while it is exported is not uploaded", async () => {
			let current = "A";
			const started = Promise.withResolvers<void>();
			const exporting = Promise.withResolvers<void>();
			const run = share(async (path) => {
				started.resolve();
				await exporting.promise;
				writeFileSync(path, header(current));
				return path;
			});
			run.context.session.sessionManager = { getSessionId: () => current };
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.spawned[0]?.child.emit("close", 0);
			await started.promise;
			current = "B";
			exporting.resolve();
			let finished = false;
			void run.done.then(() => {
				finished = true;
			});
			await vi.waitFor(() => assert.ok(finished || run.spawned.length > 1));
			assert.equal(run.spawned.length, 1, "no gist is created");
			await run.done;
			assert.deepEqual(run.statuses, ["Share cancelled: the session changed"]);
			assert.ok(run.showsPrompt());
		});

		it("an export that holds another session is not uploaded, even when the session shown is the one asked for", async () => {
			// The session switched while the export started and switched back before it ended.
			const run = share(async (path) => {
				writeFileSync(path, header("B"));
				return path;
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.spawned[0]?.child.emit("close", 0);
			let finished = false;
			void run.done.then(() => {
				finished = true;
			});
			await vi.waitFor(() => assert.ok(finished || run.spawned.length > 1));
			assert.equal(run.spawned.length, 1, "no gist is created");
			await run.done;
			assert.deepEqual(run.statuses, ["Share cancelled: the session changed"]);
			assert.ok(run.showsPrompt());
		});

		it("a failed export shows the prompt with the same error and removes the folder", async () => {
			let exportedPath = "";
			const run = share(async (path) => {
				exportedPath = path;
				throw new Error("disk full");
			});
			await vi.waitFor(() => assert.equal(run.spawned.length, 1));
			run.spawned[0]?.child.emit("close", 0);
			await run.done;
			assert.deepEqual(run.errors, ["Failed to export session: disk full"]);
			assert.ok(run.showsPrompt());
			assert.equal(existsSync(dirname(exportedPath)), false);
			assert.equal(run.returns(), 1);
		});
	});
});
