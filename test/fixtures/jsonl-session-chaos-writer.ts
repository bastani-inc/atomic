/**
 * A session writer for the JSONL chaos test (#4319): creates sessions in one directory as a subagent child does,
 * recording each one's model and thinking level in one write and then appending messages, until it is killed, the
 * disk fills, or it has written its share. Run under Bun, which loads the TypeScript sources directly.
 *
 * argv: <directory> <tag> <cwd characters> [sessions]
 */
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

const [directory, tag, cwdCharacters, sessionCount] = process.argv.slice(2);
if (!directory || !tag || !cwdCharacters) throw new Error("usage: <directory> <tag> <cwd characters> [sessions]");
const cwd = `/${tag}/${"é".repeat(Number(cwdCharacters))}`;
const limit = sessionCount === undefined ? Number.POSITIVE_INFINITY : Number(sessionCount);

function isDiskFull(error: unknown): boolean {
	for (let current = error; current instanceof Error; current = current.cause) {
		if ((current as NodeJS.ErrnoException).code === "ENOSPC") return true;
	}
	return false;
}

let written = 0;
try {
	while (written < limit) {
		const manager = await SessionManager.create(cwd, directory);
		await manager.appendStartState({ provider: "chaos", modelId: tag }, "high");
		for (let index = 0; index < 3; index++) {
			await manager.appendMessage({ role: "user", content: `${tag} message ${index}`, timestamp: Date.now() });
		}
		written++;
		if (written === 1) process.stdout.write("ready\n");
	}
	process.stdout.write(`done ${written}\n`);
} catch (error) {
	if (!isDiskFull(error)) {
		const chain: string[] = [];
		for (let current = error; current instanceof Error; current = current.cause) {
			chain.push(`${current.name}: ${current.message} (${(current as NodeJS.ErrnoException).code ?? "no code"})`);
		}
		process.stderr.write(`writer failed: ${chain.join(" <- ")}\n`);
		process.exit(1);
	}
	process.stdout.write(`full ${written}\n`);
}
