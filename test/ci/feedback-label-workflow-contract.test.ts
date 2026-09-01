import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = `${root}/.github/workflows/feedback-label.yml`;

interface FeedbackLabelWorkflow {
	on?: { issues?: { types?: string[] } };
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			"runs-on"?: string;
			"timeout-minutes"?: number;
			permissions?: Record<string, string>;
			steps?: Array<{ uses?: string; with?: { script?: string } }>;
		}
	>;
}

test("feedback label automation grants only issue labeling on opened issues", async () => {
	const source = await readText(workflowPath);
	const workflow = parseYaml(source) as FeedbackLabelWorkflow;
	assert.deepEqual(workflow.on?.issues?.types, ["opened"]);
	assert.deepEqual(workflow.permissions, {});
	const entries = Object.entries(workflow.jobs ?? {});
	assert.equal(entries.length, 1);
	const [name, job] = entries[0] ?? [];
	assert.equal(name, "label-feedback");
	assert.equal(job?.["runs-on"], "blacksmith-2vcpu-ubuntu-2404");
	assert.equal(job?.["timeout-minutes"], 5);
	assert.deepEqual(job?.permissions, { issues: "write" });
	assert.equal(job?.steps?.length, 1);
	assert.match(job?.steps?.[0]?.uses ?? "", /^actions\/github-script@[0-9a-f]{40}$/u);
	assert.match(source, /actions\/github-script@[0-9a-f]{40} # v\d/u);
});

test("feedback label automation accepts external actors but only maps the hidden marker to exact labels", async () => {
	const source = await readText(workflowPath);
	const workflow = parseYaml(source) as FeedbackLabelWorkflow;
	const script = Object.values(workflow.jobs ?? {})[0]?.steps?.[0]?.with?.script ?? "";
	assert.match(script, /owner !== "bastani-inc" \|\| repo !== "atomic"/u);
	assert.match(script, /atomic-feedback-request:\(\[A-Za-z0-9\._:-\]\{1,128\}\);kind:\(bug\|enhancement\)/u);
	assert.match(script, /matches\.length !== 1/u);
	assert.match(script, /labels: \[kind\]/u);
	assert.doesNotMatch(script, /author_association|actor|permission|role|member|collaborator/iu);
	assert.doesNotMatch(script, /createComment|update|close|lock|assign|milestone|dispatch/iu);
	assert.doesNotMatch(source, /pull_request|workflow_dispatch|issue_comment/iu);
});
