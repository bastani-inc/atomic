import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
	collectConfiguredRequiredChecks,
	evaluatePreparationReuse,
	evaluatePublishRuns,
	evaluateRequiredChecks,
	type PollClock,
	type PreparationInspection,
	type PublishRun,
	pollPublish,
	pollRequiredChecks,
	prereleaseVersionPattern,
	type RequiredChecksSnapshot,
	releaseVersionPattern,
	validateReleaseRequest,
} from "../../.atomic/workflows/lib/publish-release.js";
import publishRelease from "../../.atomic/workflows/publish-release.js";

const workflowSource = (): string => readFileSync(".atomic/workflows/publish-release.ts", "utf8");
const headSha = "1".repeat(40);
const baseSha = "2".repeat(40);
const releaseSha = "3".repeat(40);
const release = { kind: "release" as const, version: "1.2.3", branch: "release/1.2.3" };
const pullRequest = { url: "https://github.com/bastani-inc/atomic/pull/42", number: 42, headSha };
const expectedCi = { release, baseRef: "main", pullRequest };

function ciSnapshot(overrides: Partial<RequiredChecksSnapshot> = {}): RequiredChecksSnapshot {
	return {
		pullRequest: {
			number: 42,
			url: pullRequest.url,
			state: "open",
			merged: false,
			baseRef: "main",
			headRef: release.branch,
			headSha,
			repository: "bastani-inc/atomic",
		},
		required: [{ context: "test (linux)", appId: 15368 }],
		observations: [],
		...overrides,
	};
}

function publishRun(overrides: Partial<PublishRun> = {}): PublishRun {
	return {
		id: 100,
		repository: "bastani-inc/atomic",
		workflowPath: ".github/workflows/publish.yml",
		workflowName: "Publish",
		displayTitle: "Publish 1.2.3",
		event: "push",
		headBranch: "1.2.3",
		headSha: releaseSha,
		status: "completed",
		conclusion: "success",
		url: "https://github.com/bastani-inc/atomic/actions/runs/100",
		...overrides,
	};
}

function fakeClock(): PollClock & { readonly elapsed: () => number } {
	let now = 0;
	return {
		now: () => now,
		sleep: async (milliseconds, signal) => {
			if (signal.aborted) throw signal.reason;
			now += milliseconds;
		},
		elapsed: () => now,
	};
}

function validReuseState() {
	return {
		baseSha,
		remoteSha: headSha,
		localSha: headSha,
		pullRequests: [
			{
				url: pullRequest.url,
				number: pullRequest.number,
				state: "open",
				merged: false,
				baseRef: "main",
				repository: "bastani-inc/atomic",
				headRef: release.branch,
				headSha,
			},
		],
		commit: { sha: headSha, parents: [baseSha], changedFiles: ["packages/coding-agent/CHANGELOG.md"] },
	};
}

describe("publish-release request validation", () => {
	test("accepts stable and alpha versions with matching release kinds", () => {
		assert.equal(releaseVersionPattern.test("1.2.3"), true);
		assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.1"), true);
		assert.deepEqual(validateReleaseRequest("release", "1.2.3"), release);
		assert.deepEqual(validateReleaseRequest("prerelease", "1.2.3-alpha.1"), {
			kind: "prerelease",
			version: "1.2.3-alpha.1",
			branch: "prerelease/1.2.3-alpha.1",
		});
	});

	test("rejects placeholders, leading v, mismatched kinds, and alpha revision zero", () => {
		for (const [kind, version] of [
			["release", "0.0.0"],
			["release", "v1.2.3"],
			["release", "01.2.3"],
			["release", "1.2.3-alpha.1"],
			["prerelease", "1.2.3"],
			["prerelease", "1.2.3-alpha.0"],
		] as const) {
			assert.throws(() => validateReleaseRequest(kind, version), /target_version/u);
		}
	});
});

test("invalid versions return the declared structured failure output", async () => {
	for (const [release_kind, target_version] of [
		["release", "v1.2.3"],
		["prerelease", "1.2.3"],
	] as const) {
		const result = await publishRelease.run({ inputs: { target_version, release_kind, base_ref: "main" } } as never);
		assert.equal(result.status, "failed");
		assert.equal(result.target_version, target_version);
		assert.equal(result.release_kind, release_kind);
		assert.equal(result.branch, `${release_kind}/${target_version}`);
		assert.match(result.summary, /validate-release-request/u);
	}
});

test("invalid base refs return the declared structured failure output", async () => {
	const result = await publishRelease.run({
		inputs: { target_version: "1.2.3", release_kind: "release", base_ref: "origin/main" },
	} as never);
	assert.equal(result.status, "failed");
	assert.match(result.summary, /validate-release-base-ref/u);
	assert.match(result.summary, /canonical remote branch name/u);
});

test("an empty configured required-check set fails closed", () => {
	const result = evaluateRequiredChecks(ciSnapshot({ required: [] }), expectedCi);
	assert.equal(result.status, "failed");
	assert.match(result.summary, /protection.*empty/u);
});

test("configured checks preserve branch-protection and ruleset order, app identity, and duplicates", () => {
	assert.deepEqual(
		collectConfiguredRequiredChecks({ contexts: ["legacy"], checks: [{ context: "linux", app_id: 15368 }] }, [
			{ type: "creation" },
			{
				type: "required_status_checks",
				parameters: {
					required_status_checks: [{ context: "windows", integration_id: 15368 }, { context: "legacy" }],
				},
			},
		]),
		[
			{ context: "legacy", appId: null },
			{ context: "linux", appId: 15368 },
			{ context: "windows", appId: 15368 },
			{ context: "legacy", appId: null },
		],
	);
});

test("release-0.9.15 retry regression reuses the exact changelog-only branch, commit, and PR", () => {
	const result = evaluatePreparationReuse(release, "main", validReuseState());
	assert.deepEqual(result, {
		mode: "reuse",
		summary: `Reusing exact changelog-only ${release.branch} commit ${headSha} and PR #42.`,
		changedFiles: ["packages/coding-agent/CHANGELOG.md"],
		pullRequest,
	});
});

test("conflicting reuse base, files, commit, branch, and PR identity are rejected", () => {
	const valid = validReuseState();
	assert.throws(
		() => evaluatePreparationReuse(release, "main", { ...valid, localSha: "4".repeat(40) }),
		/local .* expected remote/u,
	);
	assert.throws(
		() =>
			evaluatePreparationReuse(release, "main", {
				...valid,
				commit: { ...valid.commit, parents: ["5".repeat(40)] },
			}),
		/not exactly one commit atop/u,
	);
	assert.throws(
		() => evaluatePreparationReuse(release, "main", { ...valid, commit: { ...valid.commit, sha: "6".repeat(40) } }),
		/not exactly one commit atop/u,
	);
	assert.throws(
		() =>
			evaluatePreparationReuse(release, "main", {
				...valid,
				commit: { ...valid.commit, changedFiles: ["package.json"] },
			}),
		/not changelog-only/u,
	);
	assert.throws(
		() =>
			evaluatePreparationReuse(release, "main", {
				...valid,
				pullRequests: [{ ...valid.pullRequests[0], baseRef: "next" }],
			}),
		/PR identity conflicts/u,
	);
});

test("release-0.9.15 CI regression keeps configured checks pending until they materialize", () => {
	const result = evaluateRequiredChecks(ciSnapshot(), expectedCi);
	assert.equal(result.status, "pending");
	assert.match(result.summary, /not yet created/u);
});

test("a same-name check from the wrong app does not satisfy exact configured identity", () => {
	const result = evaluateRequiredChecks(
		ciSnapshot({ observations: [{ context: "test (linux)", appId: 999, state: "success", sequence: 10 }] }),
		expectedCi,
	);
	assert.equal(result.status, "pending");
	assert.match(result.summary, /app 15368/u);
});

test("a failed exact required check fails closed", () => {
	const result = evaluateRequiredChecks(
		ciSnapshot({
			observations: [{ context: "test (linux)", appId: 15368, state: "failure", sequence: 9 }],
		}),
		expectedCi,
	);
	assert.equal(result.status, "failed");
	assert.match(result.summary, /terminal failure/u);
});

test("required-check identity drift fails before check evaluation", () => {
	const result = evaluateRequiredChecks(
		ciSnapshot({ pullRequest: { ...ciSnapshot().pullRequest, headSha: "9".repeat(40) } }),
		expectedCi,
	);
	assert.equal(result.status, "failed");
	assert.match(result.summary, /head SHA drifted/u);
});

test("an exact admin merge satisfies a non-empty CI gate", () => {
	const result = evaluateRequiredChecks(
		ciSnapshot({ pullRequest: { ...ciSnapshot().pullRequest, state: "closed", merged: true } }),
		expectedCi,
	);
	assert.equal(result.status, "passed");
	assert.match(result.summary, /admin-merged/u);
});

test("release-0.9.15 CI regression polls through delayed materialization and times out finitely", async () => {
	const controller = new AbortController();
	const clock = fakeClock();
	let calls = 0;
	const passed = await pollRequiredChecks({
		expected: expectedCi,
		signal: controller.signal,
		clock,
		intervalMs: 10,
		timeoutMs: 30,
		inspect: async () => {
			calls += 1;
			return calls < 3
				? ciSnapshot()
				: ciSnapshot({ observations: [{ context: "test (linux)", appId: 15368, state: "success", sequence: 10 }] });
		},
	});
	assert.equal(passed.status, "passed");
	assert.equal(calls, 3);
	assert.equal(clock.elapsed(), 20);

	const timeoutClock = fakeClock();
	const timedOut = await pollRequiredChecks({
		expected: expectedCi,
		signal: controller.signal,
		clock: timeoutClock,
		intervalMs: 10,
		timeoutMs: 20,
		inspect: async () => ciSnapshot(),
	});
	assert.equal(timedOut.status, "failed");
	assert.match(timedOut.summary, /timed out after 20 ms/u);
});

test("polling propagates aborts and inspection errors", async () => {
	const aborted = new AbortController();
	aborted.abort(new Error("operator stopped release"));
	await assert.rejects(
		pollRequiredChecks({ expected: expectedCi, signal: aborted.signal, inspect: async () => ciSnapshot() }),
		/operator stopped release/u,
	);
	await assert.rejects(
		pollRequiredChecks({
			expected: expectedCi,
			signal: new AbortController().signal,
			inspect: async () => {
				throw new Error("gh auth failed");
			},
		}),
		/gh auth failed/u,
	);
});

test("publish evaluation fails on identity drift and terminal failure", () => {
	assert.match(
		evaluatePublishRuns([publishRun({ headSha: "8".repeat(40) })], { release, releaseSha }).summary,
		/SHA drifted/u,
	);
	const failed = evaluatePublishRuns([publishRun({ conclusion: "failure" })], { release, releaseSha });
	assert.equal(failed.status, "failed");
	assert.match(failed.summary, /completed with failure/u);
});

test("safe fake-boundary E2E reuses exact prep and reaches delayed CI and publish success", async () => {
	const controller = new AbortController();
	const toolCalls: string[] = [];
	const taskCalls: string[] = [];
	const sideEffects: string[] = [];
	const reuse: PreparationInspection = {
		mode: "reuse",
		summary: "exact changelog-only branch and PR",
		changedFiles: ["packages/coding-agent/CHANGELOG.md"],
		pullRequest,
	};
	const ctx = {
		inputs: { target_version: "1.2.3", release_kind: "release", base_ref: "main" },
		cwd: "/safe/fake/repository",
		tool: async (name: string) => {
			toolCalls.push(name);
			if (name === "inspect-release-preparation") return reuse;
			if (name === "wait-required-ci") {
				let calls = 0;
				return await pollRequiredChecks({
					expected: expectedCi,
					signal: controller.signal,
					clock: fakeClock(),
					intervalMs: 1,
					timeoutMs: 5,
					inspect: async () => {
						calls += 1;
						return calls < 3
							? ciSnapshot()
							: ciSnapshot({
									observations: [{ context: "test (linux)", appId: 15368, state: "success", sequence: 2 }],
								});
					},
				});
			}
			if (name === "wait-publish-action") {
				let calls = 0;
				return await pollPublish({
					expected: { release, releaseSha },
					signal: controller.signal,
					clock: fakeClock(),
					intervalMs: 1,
					timeoutMs: 5,
					inspect: async () => {
						calls += 1;
						return calls < 2 ? [] : [publishRun()];
					},
				});
			}
			throw new Error(`unexpected fake tool ${name}`);
		},
		task: async (name: string) => {
			taskCalls.push(name);
			if (name === "merge-exact-head-and-sync-base") {
				sideEffects.push("fake exact-head merge/base sync");
				return {
					structured: {
						status: "succeeded",
						summary: "exact head merged and base synchronized",
						base_sha: baseSha,
					},
				};
			}
			if (name === "cut-and-push-release-tag") {
				sideEffects.push("fake detached tag verification");
				return { structured: { status: "succeeded", summary: "detached tag verified", release_sha: releaseSha } };
			}
			throw new Error(`unexpected fake task ${name}`);
		},
		exit: (options: { readonly reason?: string }) => {
			throw new Error(options.reason ?? "unexpected workflow exit");
		},
	};

	const result = await publishRelease.run(ctx as never);
	assert.equal(result.status, "completed");
	assert.equal(result.pr_url, pullRequest.url);
	assert.equal(result.tag, "1.2.3");
	assert.deepEqual(toolCalls, ["inspect-release-preparation", "wait-required-ci", "wait-publish-action"]);
	assert.deepEqual(taskCalls, ["merge-exact-head-and-sync-base", "cut-and-push-release-tag"]);
	assert.deepEqual(sideEffects, ["fake exact-head merge/base sync", "fake detached tag verification"]);
	assert.doesNotMatch(JSON.stringify(ctx), /https?:\/\/(?!safe\/fake)/u);
});

test("release-0.9.15 retry regression skips prep mutations and blocks conflicting reuse", async () => {
	const source = workflowSource();
	assert.match(source, /preparationInspection\.mode === "reuse"/u);
	assert.doesNotMatch(source, /git reset|reset --hard|push --force/u);

	let taskCalled = false;
	await assert.rejects(
		async () =>
			await publishRelease.run({
				inputs: { target_version: "1.2.3", release_kind: "release", base_ref: "main" },
				cwd: "/safe/fake/repository",
				tool: async () => {
					throw new Error("release commit contains conflicting package.json");
				},
				task: async () => {
					taskCalled = true;
				},
			} as never),
		/conflicting package\.json/u,
	);
	assert.equal(taskCalled, false);
});

test("workflow uses durable finite external gates and preserves versionless detached release contracts", () => {
	const source = workflowSource();
	assert.match(source, /ctx\.tool\([\s\S]*"wait-required-ci"/u);
	assert.match(source, /ctx\.tool\([\s\S]*"wait-publish-action"/u);
	assert.match(source, /REQUIRED_CHECK_TIMEOUT_MS \+ RELEASE_TOOL_TIMEOUT_BUFFER_MS/u);
	assert.match(source, /PUBLISH_TIMEOUT_MS \+ RELEASE_TOOL_TIMEOUT_BUFFER_MS/u);
	assert.doesNotMatch(source, /inspectGate|watch-required-CI|watch-publish-action/u);
	assert.match(source, /package manifests, lockfiles, Cargo files, and generated version files remain at 0\.0\.0/u);
	assert.match(source, /scripts\/cut-release\.ts \$\{release\.version\} --base \$\{baseRef\} --push --yes/u);
	assert.doesNotMatch(source, /gh workflow run|workflow_dispatch|environment:\s*npm-publish/u);
});
