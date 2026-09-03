import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeAll, describe, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ShareProcess = EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	kill: ReturnType<typeof vi.fn>;
};

type ShareContext = {
	session: { exportToJsonl: (path: string) => void };
	ui: { setFocus: () => void; requestRender: () => void };
	editorContainer: Container;
	editor: Container;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

describe("InteractiveMode /share", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps concurrent session exports isolated", async () => {
		const processes: ShareProcess[] = [];
		const uploadPaths: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
			uploadPaths.push(args.at(-1)!);
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			processes.push(child);
			return child;
		});

		const errors: string[] = [];
		const context = (name: "A" | "B"): ShareContext => ({
			session: { exportToJsonl: (path) => writeFileSync(path, name) },
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

		assert.equal(uploadPaths.length, 2);
		assert.notEqual(uploadPaths[0], uploadPaths[1]);
		assert.equal(readFileSync(uploadPaths[0]!, "utf8"), "A");
		assert.equal(readFileSync(uploadPaths[1]!, "utf8"), "B");
		for (const [index, child] of processes.entries()) {
			child.stdout.end(`https://gist.github.com/test/${index + 1}\n`);
			child.stderr.end();
			child.emit("close", 0);
		}
		await Promise.all([shareA, shareB]);
		assert.deepEqual(errors, []);
	});
});
