import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { StageSessionRuntime } from "./stage-runner-helpers.js";
import { makeRig } from "./waiting-stage-controller-rig.js";

type Messages = StageSessionRuntime["messages"];

function answer(text: string): Messages[number] {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

test("an output artifact keeps the answer a stage gave to a message before it was released, and adds what its reopened session answers (#4309)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "waiting-stage-release-artifact-"));
	try {
		let answers = 0;
		const rig = makeRig({
			stageOptions: { cwd: directory },
			// Each session has its own transcript, as a session reopened from the store does.
			customize: () => {
				const messages: Messages = [];
				return {
					messages,
					async prompt() {
						answers += 1;
						messages.push(answer(`answer ${answers}`));
					},
				};
			},
		});

		await rig.ctx.prompt("draft", { output: "out.md" });
		await rig.ctx.__sendUserMessage("add the tests");
		await rig.ctx.release();
		await rig.ctx.__continuePrompt("finish");

		assert.equal(rig.created(), 2);
		assert.equal(
			readFileSync(join(directory, "out.md"), "utf8"),
			"answer 1\n\n## Supplement 1\n\nanswer 2\n\n## Supplement 2\n\nanswer 3",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
