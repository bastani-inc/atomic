// Starts a helper in its own process group that inherits stdout and stderr, then exits. The helper is out of reach of
// the server's process-group signals and keeps the pipes open. It exits on its own after 30 s, so a failed test cannot
// leave it running.
import { spawn } from "node:child_process";

const helper = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30_000)"], {
	stdio: ["ignore", "inherit", "inherit"],
	detached: true,
});
console.error(`helper ${helper.pid}`);
helper.unref();
process.exit(0);
