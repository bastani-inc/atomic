import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { parseHTML } from "linkedom";
import { test } from "vitest";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";

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
	const { window, document } = parseHTML(readFileSync(output, "utf8"));
	Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
	const location = { search: "", hash: "" };
	Object.defineProperty(window, "location", { configurable: true, value: location });
	const context = {
		window,
		document,
		atob,
		TextDecoder,
		URLSearchParams,
		console,
		location,
		navigator: { clipboard: undefined },
		history: { replaceState: () => undefined },
		localStorage: { getItem: () => null, setItem: () => undefined },
		matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
		requestAnimationFrame: (callback: () => void) => {
			callback();
			return 0;
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined,
	};
	for (const script of document.querySelectorAll("script")) {
		if (script.getAttribute("type") !== "application/json") runInNewContext(script.textContent ?? "", context);
	}
	return document;
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
				fauxAssistantMessage("Inspection done"),
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
		const recorded = card?.querySelector("details")?.textContent ?? "";
		assert.ok(recorded.includes(JSON.stringify(args, null, 2)));
		assert.ok(recorded.includes("Recorded receipt: 42"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a saved parallel count alone does not generate an unbounded page of empty subagent cards (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-parallel-file-export-"));
	try {
		const args = { tasks: [{ agent: "worker", task: "Inspect the sample", count: 1001 }] };
		const message = fauxAssistantMessage([fauxToolCall("subagent", args, { id: "parallel" })], {
			stopReason: "toolUse",
		});
		const page = await exportSavedMessages(dir, [message]);
		const card = page.getElementById("tool-call-parallel");
		assert.equal(card?.querySelectorAll(".tool-header .ansi-line").length, 1);
		assert.match(card?.querySelector(".tool-header")?.textContent ?? "", /parallel launch/);
		assert.ok(card?.querySelector("details")?.textContent?.includes(JSON.stringify(args, null, 2)));
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
		rmSync(join(templates, "extension-cards.mjs"));
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

test("saved calls use the shipped extension presentations without loading project tools (#5658)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-extension-file-export-"));
	try {
		const calls = [
			["workflow", { workflow: "audit" }, "Workflow(audit)"],
			["intercom", { action: "send", to: "reader" }, "Intercom(send → reader)"],
			["contact_supervisor", { reason: "need_decision" }, "Supervisor(need decision)"],
			["web_search", { query: "sample" }, "WebSearch(sample)"],
			["fetch_content", { urls: ["https://example.org"] }, "Fetch(example.org)"],
			["mcp__sample__lookup", { query: "sample" }, "sample/lookup"],
			["project_only", { query: "sample" }, "project_only"],
		] as const;
		const page = await exportSavedMessages(dir, [
			fauxAssistantMessage(
				calls.map(([name, args]) => fauxToolCall(name, { ...args }, { id: name })),
				{ stopReason: "toolUse" },
			),
		]);
		for (const [name, args, label] of calls) {
			const card = page.getElementById(`tool-call-${name}`);
			assert.ok(card?.querySelector(".tool-header")?.textContent?.includes(label), name);
			assert.ok(card.textContent?.includes(JSON.stringify(args, null, 2)), name);
			assert.equal(Boolean(card.querySelector("details")), name !== "project_only", name);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
