// Stand-in for the GitHub CLI in publishPullRequest tests. Appends its argv to GH_STUB_LOG and answers by GH_STUB_MODE.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.GH_STUB_MODE ?? "create";
if (args[0] === "auth") process.exit(mode === "unauthenticated" ? 1 : 0);
if (args[0] === "pr" && args[1] === "list") {
	process.stdout.write(mode === "existing" ? JSON.stringify([{ url: "https://example.test/pr/7", isDraft: false }]) : "[]");
	process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
	if (mode === "create-fails") {
		process.stderr.write("GraphQL: something went wrong");
		process.exit(1);
	}
	process.stdout.write("Creating pull request\nhttps://example.test/pr/8\n");
	process.exit(0);
}
process.exit(2);
