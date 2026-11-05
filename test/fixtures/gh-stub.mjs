// Stand-in for the GitHub CLI in publishPullRequest tests. Appends its argv to GH_STUB_LOG and answers by GH_STUB_MODE.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify({ args, prompt: process.env.GH_PROMPT_DISABLED ?? null })}\n`);
const mode = process.env.GH_STUB_MODE ?? "create";
if (args[0] === "auth") {
	if (mode === "hang") setTimeout(() => process.exit(0), 30_000);
	else process.exit(mode === "unauthenticated" ? 1 : 0);
} else if (args[0] === "pr" && args[1] === "list") {
	if (mode === "garbage") process.stdout.write("not json");
	else if (mode === "list-fails") {
		process.stdout.write("HTTP 502 from list\n");
		process.exit(1);
	} else process.stdout.write(mode === "existing" ? JSON.stringify([{ url: "https://example.test/pr/7", isDraft: true }]) : "[]");
	process.exit(0);
} else if (args[0] === "pr" && args[1] === "create") {
	if (mode === "create-fails") {
		process.stderr.write("GraphQL: something went wrong\n");
		process.exit(1);
	}
	if (mode === "killed") process.kill(process.pid, "SIGKILL");
	process.stdout.write("Creating pull request\nhttps://example.test/pr/8\n");
	process.exit(0);
} else process.exit(2);
