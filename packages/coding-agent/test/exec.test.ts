import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { execCommand } from "../src/core/exec.js";

describe("execCommand", () => {
	it("reports spawn errors in stderr (pi #11085)", async () => {
		const result = await execCommand("pi-command-that-does-not-exist-11085", [], process.cwd());

		assert.equal(result.code, 1);
		assert.equal(result.killed, false);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /ENOENT/);
	});

	it("keeps stderr empty when a command exits silently", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(1)"], process.cwd());

		assert.deepEqual(result, { stdout: "", stderr: "", code: 1, killed: false });
	});

	it("decodes UTF-8 characters split across output chunks (pi #11312)", async () => {
		const script = `
			const bytes = Buffer.from("你好");
			process.stdout.write(bytes.subarray(0, 1));
			process.stderr.write(bytes.subarray(0, 1));
			setTimeout(() => {
				process.stdout.write(bytes.subarray(1));
				process.stderr.write(bytes.subarray(1));
			}, 100);
		`;
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());

		assert.deepEqual(result, { stdout: "你好", stderr: "你好", code: 0, killed: false });
	});
});
