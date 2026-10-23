import { fork } from "node:child_process";

const child = fork(
	"--internal-workflow-worker",
	[JSON.stringify({ journalPath: process.argv[3], root: "binary-root", definitions: [] })],
	{ stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [], execPath: process.argv[2] },
);
let stderr = "";
child.stderr?.on("data", (chunk: Buffer) => {
	stderr = (stderr + chunk.toString()).slice(-4096);
});
child.once("message", (message: { kind?: string }) => {
	console.log(`worker ${message.kind}`);
	child.kill("SIGKILL");
});
child.once("exit", (code) => {
	if (code !== null) {
		console.error(`worker exited ${code} before ready: ${stderr}`);
		process.exit(1);
	}
	process.exit(0);
});
