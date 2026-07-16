import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCliProcess } from "./cli-test-helpers.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tempDirs: string[] = [];


function assistantText(stdout: string): string {
	let text = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
	}
	return text;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

test("source CLI preserves ordinary Cursor text history across resumed processes", async () => {
	const root = join(tmpdir(), `atomic-cursor-resumed-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const extension = resolve(repoRoot, "packages/cursor/test/resumed-history-extension.ts");
	const session = join(root, "session.jsonl");
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		cursor: {
			type: "oauth",
			access: `x.${Buffer.from(JSON.stringify({ sub: "resumed-cli-test" })).toString("base64url")}.x`,
			refresh: "test-refresh",
			expires: Date.now() + 60_000,
		},
	}));
	const env = { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" };
	const common = ["--mode", "json", "--print", "--no-tools", "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session", session];
	const first = await runCliProcess([...common, "--model", "cursor/continuity-route", "The continuity code is VIOLET RIVER 83. Reply ACK."], { cwd, env });
	expect({ code: first.code, timedOut: first.timedOut, stderr: first.stderr }).toEqual({ code: 0, timedOut: false, stderr: "" });
	expect(assistantText(first.stdout)).toBe("ACK");
	const resumed = await runCliProcess([...common, "What was the continuity code?"], { cwd, env });
	expect({ code: resumed.code, timedOut: resumed.timedOut, stderr: resumed.stderr }).toEqual({ code: 0, timedOut: false, stderr: "" });
	expect(assistantText(resumed.stdout)).toBe("VIOLET RIVER 83");
	const persisted = readFileSync(session, "utf8");
	expect(persisted).toContain("VIOLET RIVER 83");
});
