import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";
import { StdioTransport } from "../../src/extensions/mcp/client/index.js";

vi.mock("cross-spawn", () => ({
	default: () => {
		const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: null, stdout: null, stderr: null });
		child.on("error", () => {});
		process.nextTick(() => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })));
		return child;
	},
}));

describe("StdioTransport when the process cannot be created", () => {
	it("reports the spawn error for a child that has no pipes", async () => {
		const transport = new StdioTransport({ command: "irrelevant" });
		await assert.rejects(transport.start(), { code: "EMFILE" });
	});
});
