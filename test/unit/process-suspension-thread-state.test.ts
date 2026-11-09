import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createProcessSuspender } from "../helpers/process-suspension.js";

const probe = vi.hoisted(() => ({ stdout: "", command: "", args: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	const execFile = Object.assign(vi.fn(), {
		[Symbol.for("nodejs.util.promisify.custom")]: async (command: string, args: string[]) => {
			probe.command = command;
			probe.args = args;
			return { stdout: probe.stdout, stderr: "" };
		},
	});
	return { ...original, execFile };
});

test.each(
	(["linux", "darwin"] as const).flatMap((platform) =>
		[
			{ label: "a stopped leader with a running worker", states: "T\nSl\n", stopped: false },
			{ label: "all threads stopped", states: "T\nT\n", stopped: true },
			{ label: "stopped states with flags and whitespace", states: " T \n Ts \n", stopped: true },
			{ label: "a running leader", states: "S\nT\n", stopped: false },
			{ label: "no reported threads", states: "", stopped: false },
		].map((scenario) => ({ ...scenario, platform })),
	),
)("$platform suspension recognizes $label (#4319)", async ({ states, stopped, platform }) => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platformDescriptor);
	Object.defineProperty(process, "platform", { value: platform });
	probe.stdout = states;
	try {
		const suspender = await createProcessSuspender();
		assert.equal(await suspender.isSuspended(12345), stopped);
		assert.equal(probe.command, "ps");
		assert.deepEqual(probe.args, [...(platform === "linux" ? ["-L"] : []), "-o", "stat=", "-p", "12345"]);
		await suspender.close();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
});
