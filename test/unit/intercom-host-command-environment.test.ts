import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { systemSources } from "../../packages/intercom/broker/broker-instance.ts";

const saved = process.env.PSModulePath;

afterEach(() => {
	if (saved === undefined) delete process.env.PSModulePath;
	else process.env.PSModulePath = saved;
});

test("a host command starts without the parent's PSModulePath, which breaks Windows PowerShell's Get-Process under a PowerShell 7 parent", async () => {
	process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
	process.env.ATOMIC_HOST_COMMAND_ENV_PROBE = "kept";
	try {
		const output = await systemSources().run(process.execPath, [
			"-e",
			"process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^psmodulepath$/i.test(k)).concat(process.env.ATOMIC_HOST_COMMAND_ENV_PROBE ?? 'missing')))",
		]);
		assert.deepEqual(JSON.parse(output), ["kept"]);
	} finally {
		delete process.env.ATOMIC_HOST_COMMAND_ENV_PROBE;
	}
});
