import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import { openExportedPage } from "./helpers/exported-page.ts";

async function exportSavedMessages(dir: string, messages: unknown[], env: NodeJS.ProcessEnv = {}) {
	const input = join(dir, "session.jsonl");
	const entries = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "file-export",
			cwd: dir,
			timestamp: new Date(0).toISOString(),
		},
		...messages.map((message, index) => ({
			type: "message",
			id: `e${index}`,
			parentId: index ? `e${index - 1}` : null,
			timestamp: new Date(index + 1).toISOString(),
			message,
		})),
	];
	writeFileSync(input, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const output = join(dir, "out.html");
	await promisify(execFile)(
		"bun",
		[fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--offline", "--export", input, output],
		{
			cwd: dir,
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: join(dir, "profile"), ...env },
		},
	);
	return openExportedPage(output);
}

test("a saved subagent call opens as a card with its recorded prompt, tool calls and result (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-agent-file-export-"));
	try {
		const args = { agent: "worker", task: "Inspect the sample", worktree: true };
		const message = fauxAssistantMessage([fauxToolCall("subagent", args, { id: "launch" })], {
			stopReason: "toolUse",
		});
		const child = {
			...args,
			status: "ok",
			exitCode: 0,
			messages: [
				fauxAssistantMessage([fauxToolCall("read", { path: "sample.txt" }, { id: "child-read" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([
					{ type: "text", text: "Still inspecting" },
					{ type: "text", text: "Inspection done" },
					{ type: "text", text: "   " },
				]),
			],
		};
		const result = {
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "launch",
			content: [{ type: "text", text: "Recorded receipt: 42" }],
			details: { mode: "single", results: [child] },
			isError: false,
			timestamp: 2,
		};
		const page = await exportSavedMessages(dir, [message, result]);
		const card = page.getElementById("tool-call-launch");
		assert.match(card?.querySelector(".tool-header")?.textContent ?? "", /Agent\(worker · Inspect the sample\)/);
		assert.match(
			card?.querySelector(".tool-output.expandable .output-full")?.textContent ?? "",
			/Prompt[\s\S]*Inspect the sample[\s\S]*Tool calls[\s\S]*Read\(sample.txt\)[\s\S]*Result[\s\S]*Inspection done/,
		);
		assert.doesNotMatch(card?.querySelector(".output-full")?.textContent ?? "", /Still inspecting/);
		const recorded = card?.querySelector("details")?.textContent ?? "";
		assert.ok(recorded.includes(JSON.stringify(args, null, 2)));
		assert.ok(recorded.includes("Recorded receipt: 42"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two turns can reuse a provider call ID without sharing either child's card or recorded receipt (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-file-export-turns-"));
	try {
		const messages = ["amber", "violet"].flatMap((owner) => {
			const args = { agent: owner, task: `Read ${owner}'s file` };
			return [
				fauxAssistantMessage([fauxToolCall("subagent", args, { id: "subagent:0" })], { stopReason: "toolUse" }),
				{
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "subagent:0",
					isError: false,
					timestamp: 2,
					content: [{ type: "text", text: `${owner}'s receipt` }],
					details: {
						mode: "single",
						results: [
							{
								...args,
								status: "ok",
								toolCalls: [{ text: `read ${owner}.txt` }],
								finalOutput: `${owner}'s answer`,
							},
						],
					},
				},
			];
		});
		const cards = [...(await exportSavedMessages(dir, messages)).querySelectorAll(".tool-execution")];
		assert.equal(cards.length, 2);
		for (const [i, owner] of ["amber", "violet"].entries()) {
			assert.ok(cards[i]?.querySelector(".tool-header")?.textContent?.includes(`Agent(${owner}`));
			assert.ok(cards[i]?.querySelector("details")?.textContent?.includes(`${owner}'s receipt`));
			assert.ok(!cards[i]?.textContent?.includes(i ? "amber" : "violet"));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unstarted and rejected parallel declarations stay one raw row, regardless of count (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-parallel-file-export-"));
	try {
		const messages = [1000, 1001].flatMap((count) => {
			const args = { tasks: [{ agent: "worker", task: "Inspect the sample", count }] };
			const id = String(count);
			const launch = fauxAssistantMessage([fauxToolCall("subagent", args, { id })], { stopReason: "toolUse" });
			return count === 1000
				? [launch]
				: [
						launch,
						{
							role: "toolResult",
							toolName: "subagent",
							toolCallId: id,
							isError: true,
							timestamp: 2,
							content: [{ type: "text", text: "Too many parallel tasks" }],
							details: { mode: "parallel", results: [], taskError: "Too many parallel tasks" },
						},
					];
		});
		const page = await exportSavedMessages(dir, messages);
		for (const count of [1000, 1001]) {
			const row = page.getElementById(`tool-call-${count}`);
			assert.equal(row?.querySelector(".tool-header")?.textContent, "subagent");
			assert.match(row?.querySelector(".tool-output pre")?.textContent ?? "", new RegExp(`"count": ${count}`));
			assert.equal(row?.querySelector("details"), null);
		}
		assert.match(page.getElementById("tool-call-1001")?.textContent ?? "", /Too many parallel tasks/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a compacted child with calls in another file keeps its recorded answer without an empty history claim (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-compacted-file-export-"));
	try {
		const args = { agent: "worker", task: "Inspect the sample" };
		const page = await exportSavedMessages(dir, [
			fauxAssistantMessage([fauxToolCall("subagent", args, { id: "launch" })], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "launch",
				isError: false,
				timestamp: 2,
				content: [{ type: "text", text: "Inspection done" }],
				details: {
					mode: "single",
					results: [
						{
							...args,
							status: "ok",
							sessionFile: "child.jsonl",
							progressSummary: { toolCount: 1 },
							finalOutput: "Inspection done",
						},
					],
				},
			},
		]);
		const row = page.getElementById("tool-call-launch");
		assert.equal(row?.querySelector(".tool-header")?.textContent, "subagent");
		assert.ok(row?.textContent?.includes("Inspection done"));
		assert.doesNotMatch(row.textContent, /Tool calls/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a template installation without the extension cards still exports the original saved arguments (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-file-export-assets-"));
	try {
		const assets = join(dir, "assets");
		const templates = join(assets, "src/core/export-html");
		cpSync(new URL("../src/core/export-html", import.meta.url), templates, { recursive: true });
		rmSync(join(templates, "extension-cards.mjs"), { force: true });
		cpSync(new URL("../src/modes/interactive/theme", import.meta.url), join(assets, "src/modes/interactive/theme"), {
			recursive: true,
		});
		cpSync(new URL("../package.json", import.meta.url), join(assets, "package.json"));
		const args = { agent: "worker", task: "Inspect the sample" };
		const message = fauxAssistantMessage([fauxToolCall("subagent", args, { id: "launch" })], {
			stopReason: "toolUse",
		});
		const page = await exportSavedMessages(dir, [message], { ATOMIC_PACKAGE_DIR: assets });
		assert.ok(page.getElementById("tool-call-launch")?.textContent?.includes(JSON.stringify(args, null, 2)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("other extension and project tools keep their recorded presentation (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-extension-file-export-"));
	try {
		const calls = [
			["workflow", { workflow: "audit" }],
			["intercom", { action: "send", to: "reader" }],
			["contact_supervisor", { reason: "need_decision" }],
			["web_search", { query: "sample" }],
			["fetch_content", { urls: ["https://example.org"] }],
			["mcp__sample__lookup", { query: "sample" }],
			["project_only", { query: "sample" }],
		] as const;
		const page = await exportSavedMessages(dir, [
			fauxAssistantMessage(
				calls.map(([name, args]) => fauxToolCall(name, { ...args }, { id: name })),
				{ stopReason: "toolUse" },
			),
		]);
		for (const [name, args] of calls) {
			const card = page.getElementById(`tool-call-${name}`);
			assert.ok(card, name);
			assert.equal(card.querySelector(".tool-header")?.textContent, name);
			assert.equal(card.querySelector("pre")?.textContent, JSON.stringify(args, null, 2));
			assert.equal(card.querySelector("details"), null);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
