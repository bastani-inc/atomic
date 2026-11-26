// Seeds a libSQL store with Atomic 0.10.11-alpha.2: two sessions, one with a worktree snapshot and a tool output,
// a fork of its leaf and a fork from an earlier entry, each with entries of its own.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWorktreeSnapshot, SessionManager, SqlSessionStore } from "@bastani/atomic";
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const [url, repo] = process.argv.slice(2);
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "seed@example.com");
git("config", "user.name", "Seed");
git("config", "commit.gpgSign", "false");
writeFileSync(join(repo, "README.md"), "hello\n");
git("add", "-A");
git("commit", "-q", "-m", "initial");
writeFileSync(join(repo, "README.md"), "uncommitted edit\n");
writeFileSync(join(repo, "untracked.txt"), "untracked file\n");

const database = await openLibsqlDatabase({ url });
const store = await SqlSessionStore.open(database);
try {
	const main = await SessionManager.create(store, repo);
	const first = await main.appendMessage({ role: "user", content: "first question", timestamp: 1 });
	await main.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "openai-completions",
		provider: "seed",
		model: "seed-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 2,
	});
	const capture = await captureWorktreeSnapshot(repo, { blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(`capture ${capture.status}`);
	await main.appendWorktreeSnapshot(capture.snapshot.root, capture.snapshot.id, capture.snapshot);
	await main.appendMessage({ role: "user", content: "second question ".repeat(20), timestamp: 3 });
	const leaf = await main.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "tool output line\n".repeat(20) }],
		isError: false,
		timestamp: 4,
	});
	const fork = await main.forkTo(repo, store);
	await fork.appendMessage({ role: "user", content: "question asked in the fork of the leaf", timestamp: 5 });
	const early = await main.captureFork(first)();
	await early.appendMessage({ role: "user", content: "question asked in the fork of the first entry", timestamp: 6 });
	const other = await SessionManager.create(store, repo);
	await other.appendMessage({ role: "user", content: "an unrelated session", timestamp: 7 });
	console.log(
		JSON.stringify({
			main: main.getSessionId(),
			leaf,
			forkOfLeaf: fork.getSessionId(),
			forkOfFirst: early.getSessionId(),
			other: other.getSessionId(),
			snapshot: capture.snapshot.id,
			snapshotBlobs: capture.blobs.length,
		}),
	);
} finally {
	await store.close();
	await database.close();
}
