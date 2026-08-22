import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
	collectConfiguredRequiredChecks,
	createReleaseBoundary,
	evaluatePreparationReuse,
	evaluatePublishRuns,
	evaluateRequiredChecks,
	type PollClock,
	type PublishRun,
	pollRequiredChecks,
	prereleaseVersionPattern,
	type ReleaseCommandResult,
	type ReleaseCommandTransport,
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
		worktreeStatus: "",
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

function commandResult(stdout = "", exitCode = 0, stderr = ""): ReleaseCommandResult {
	return { exitCode, stdout, stderr };
}

function apiPull() {
	return {
		number: 42,
		html_url: pullRequest.url,
		state: "open",
		merged: false,
		base: { ref: "main", repo: { full_name: "bastani-inc/atomic" } },
		head: { ref: release.branch, sha: headSha },
	};
}

function fakeTransport(
	respond: (argv: readonly string[], call: number) => ReleaseCommandResult | Promise<ReleaseCommandResult>,
): ReleaseCommandTransport & {
	readonly calls: readonly (readonly string[])[];
	readonly signals: readonly AbortSignal[];
} {
	const calls: (readonly string[])[] = [];
	const signals: AbortSignal[] = [];
	return {
		calls,
		signals,
		run: async (argv, _cwd, signal) => {
			calls.push(argv);
			signals.push(signal);
			return await respond(argv, calls.length);
		},
	};
}

function exactPreparationResponse(argv: readonly string[], worktreeStatus = ""): ReleaseCommandResult | undefined {
	const command = argv.join(" ");
	if (command === "git status --porcelain=v1 --untracked-files=all") return commandResult(worktreeStatus);
	if (command.includes(`git ls-remote --heads origin refs/heads/${release.branch}`)) {
		return commandResult(`${headSha}\trefs/heads/${release.branch}`);
	}
	if (command.includes("git ls-remote --heads origin refs/heads/main")) {
		return commandResult(`${baseSha}\trefs/heads/main`);
	}
	if (command.includes(`git show-ref --verify refs/heads/${release.branch}`)) {
		return commandResult(`${headSha} refs/heads/${release.branch}`);
	}
	if (command.includes("/pulls?state=open")) return commandResult(JSON.stringify([apiPull()]));
	return undefined;
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

test("preparation adapter exhausts commit pages and validates both sides of renames", async () => {
	const firstPage = Array.from({ length: 100 }, (_, index) => ({
		filename: `packages/package-${index}/CHANGELOG.md`,
	}));
	const paginated = fakeTransport((argv) => {
		const preparation = exactPreparationResponse(argv);
		if (preparation !== undefined) return preparation;
		const command = argv.join(" ");
		if (command.endsWith(`commits/${headSha}?per_page=100&page=1`)) {
			return commandResult(JSON.stringify({ sha: headSha, parents: [{ sha: baseSha }], files: firstPage }));
		}
		if (command.endsWith(`commits/${headSha}?per_page=100&page=2`)) {
			return commandResult(
				JSON.stringify({ sha: headSha, parents: [{ sha: baseSha }], files: [{ filename: "package.json" }] }),
			);
		}
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", { transport: paginated }).inspectPreparation({
			cwd: "/safe/fake/repository",
			release,
			baseRef: "main",
			signal: new AbortController().signal,
		}),
		/not changelog-only.*package\.json/u,
	);
	assert.ok(paginated.calls.some((argv) => argv.join(" ").endsWith("per_page=100&page=2")));

	const renamed = fakeTransport((argv) => {
		const preparation = exactPreparationResponse(argv);
		if (preparation !== undefined) return preparation;
		const command = argv.join(" ");
		if (command.endsWith(`commits/${headSha}?per_page=100&page=1`)) {
			return commandResult(
				JSON.stringify({
					sha: headSha,
					parents: [{ sha: baseSha }],
					files: [{ filename: "packages/new/CHANGELOG.md", previous_filename: "package.json" }],
				}),
			);
		}
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", { transport: renamed }).inspectPreparation({
			cwd: "/safe/fake/repository",
			release,
			baseRef: "main",
			signal: new AbortController().signal,
		}),
		/not changelog-only.*package\.json/u,
	);
});

test("rules lookup failures cannot be hidden by a partial classic protection set", async () => {
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) {
			return commandResult(JSON.stringify({ contexts: ["classic"] }));
		}
		if (command.includes("/rules/branches/main")) return commandResult("", 1, "HTTP 404: Not Found");
		if (command.includes("/check-runs")) {
			return commandResult(
				JSON.stringify({
					check_runs: [{ id: 1, name: "classic", status: "completed", conclusion: "success", app: { id: 1 } }],
				}),
			);
		}
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", {
			transport,
			clock: fakeClock(),
			requiredCheckIntervalMs: 1,
			requiredCheckTimeoutMs: 2,
		}).waitForRequiredChecks({ release, baseRef: "main", pullRequest, signal: new AbortController().signal }),
		/rules\/branches\/main\?per_page=100&page=1 failed.*404/u,
	);
});

test("branch rules paginate before a page-two app-bound check can pass", async () => {
	const firstPage = [
		{
			type: "required_status_checks",
			parameters: { required_status_checks: [{ context: "page-one", integration_id: 15368 }] },
		},
		...Array.from({ length: 99 }, () => ({ type: "creation" })),
	];
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) return commandResult(JSON.stringify({}));
		if (command.endsWith("/rules/branches/main")) return commandResult(JSON.stringify(firstPage));
		if (command.endsWith("/rules/branches/main?per_page=100&page=1")) {
			return commandResult(JSON.stringify(firstPage));
		}
		if (command.endsWith("/rules/branches/main?per_page=100&page=2")) {
			return commandResult(
				JSON.stringify([
					{
						type: "required_status_checks",
						parameters: { required_status_checks: [{ context: "page-two", integration_id: 15368 }] },
					},
				]),
			);
		}
		if (command.includes("/check-runs")) {
			return commandResult(
				JSON.stringify({
					check_runs: [
						{ id: 1, name: "page-one", status: "completed", conclusion: "success", app: { id: 15368 } },
					],
				}),
			);
		}
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	const result = await createReleaseBoundary("/safe/fake/repository", {
		transport,
		clock: fakeClock(),
		requiredCheckIntervalMs: 1,
		requiredCheckTimeoutMs: 2,
	}).waitForRequiredChecks({ release, baseRef: "main", pullRequest, signal: new AbortController().signal });
	assert.equal(result.status, "failed");
	assert.match(result.summary, /not yet created.*page-two \(app 15368\)/u);
	const ruleCalls = transport.calls
		.map((argv) => argv.join(" "))
		.filter((command) => command.includes("/rules/branches/"));
	assert.ok(ruleCalls.some((command) => command.endsWith("/rules/branches/main?per_page=100&page=1")));
	assert.ok(ruleCalls.some((command) => command.endsWith("/rules/branches/main?per_page=100&page=2")));
	assert.equal(
		ruleCalls.some((command) => command.endsWith("&page=3")),
		false,
	);
});

test("a later branch-rules page API failure rejects without evaluating partial rules", async () => {
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) return commandResult(JSON.stringify({}));
		if (command.endsWith("/rules/branches/main?per_page=100&page=1")) {
			return commandResult(JSON.stringify(Array.from({ length: 100 }, () => ({ type: "creation" }))));
		}
		if (command.endsWith("/rules/branches/main?per_page=100&page=2")) {
			return commandResult("", 1, "authentication denied");
		}
		if (command.includes("/check-runs")) return commandResult(JSON.stringify({ check_runs: [] }));
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", { transport }).waitForRequiredChecks({
			release,
			baseRef: "main",
			pullRequest,
			signal: new AbortController().signal,
		}),
		/rules\/branches\/main\?per_page=100&page=2 failed.*authentication denied/u,
	);
});

test("malformed JSON on a later branch-rules page rejects without evaluating partial rules", async () => {
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) return commandResult(JSON.stringify({}));
		if (command.endsWith("/rules/branches/main?per_page=100&page=1")) {
			return commandResult(JSON.stringify(Array.from({ length: 100 }, () => ({ type: "creation" }))));
		}
		if (command.endsWith("/rules/branches/main?per_page=100&page=2")) return commandResult("{");
		if (command.includes("/check-runs")) return commandResult(JSON.stringify({ check_runs: [] }));
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", { transport }).waitForRequiredChecks({
			release,
			baseRef: "main",
			pullRequest,
			signal: new AbortController().signal,
		}),
		SyntaxError,
	);
});

test("valid non-array JSON on a later branch-rules page fails closed", async () => {
	const firstPage = [
		{
			type: "required_status_checks",
			parameters: { required_status_checks: [{ context: "page-one", integration_id: 15368 }] },
		},
		...Array.from({ length: 99 }, () => ({ type: "creation" })),
	];
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) return commandResult(JSON.stringify({}));
		if (command.endsWith("/rules/branches/main?per_page=100&page=1")) {
			return commandResult(JSON.stringify(firstPage));
		}
		if (command.endsWith("/rules/branches/main?per_page=100&page=2")) return commandResult(JSON.stringify("x"));
		if (command.includes("/check-runs")) {
			return commandResult(
				JSON.stringify({
					check_runs: [
						{ id: 1, name: "page-one", status: "completed", conclusion: "success", app: { id: 15368 } },
					],
				}),
			);
		}
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", { transport }).waitForRequiredChecks({
			release,
			baseRef: "main",
			pullRequest,
			signal: new AbortController().signal,
		}),
		/GitHub branch-rules page 2 response must be an array/u,
	);
});

test("the exact classic unprotected-branch response is the only allowed absent source", async () => {
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) {
			return commandResult("", 1, "gh: Branch not protected (HTTP 404)");
		}
		if (command.includes("/rules/branches/main")) {
			return commandResult(
				JSON.stringify([
					{
						type: "required_status_checks",
						parameters: { required_status_checks: [{ context: "rules-only", integration_id: 15368 }] },
					},
				]),
			);
		}
		if (command.includes("/check-runs")) {
			return commandResult(
				JSON.stringify({
					check_runs: [
						{ id: 1, name: "rules-only", status: "completed", conclusion: "success", app: { id: 15368 } },
					],
				}),
			);
		}
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	const result = await createReleaseBoundary("/safe/fake/repository", {
		transport,
		clock: fakeClock(),
		requiredCheckIntervalMs: 1,
		requiredCheckTimeoutMs: 2,
	}).waitForRequiredChecks({ release, baseRef: "main", pullRequest, signal: new AbortController().signal });
	assert.equal(result.status, "passed");
});

test("a generic classic protection 404 cannot hide a partial required-check set", async () => {
	const transport = fakeTransport((argv) => {
		const command = argv.join(" ");
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) {
			return commandResult("", 1, "HTTP 404: Not Found");
		}
		if (command.includes("/rules/branches/main")) {
			return commandResult(
				JSON.stringify([
					{
						type: "required_status_checks",
						parameters: { required_status_checks: [{ context: "rules-only", integration_id: 15368 }] },
					},
				]),
			);
		}
		if (command.includes("/check-runs")) return commandResult(JSON.stringify({ check_runs: [] }));
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		throw new Error(`unexpected fake command: ${command}`);
	});
	await assert.rejects(
		createReleaseBoundary("/safe/fake/repository", {
			transport,
			clock: fakeClock(),
			requiredCheckIntervalMs: 1,
			requiredCheckTimeoutMs: 2,
		}).waitForRequiredChecks({ release, baseRef: "main", pullRequest, signal: new AbortController().signal }),
		/protection\/required_status_checks failed.*HTTP 404: Not Found/u,
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

test("safe fake-boundary E2E executes production Git/GitHub adapters through delayed CI and publish", async () => {
	const controller = new AbortController();
	const toolCalls: string[] = [];
	const taskCalls: string[] = [];
	const sideEffects: string[] = [];
	let checkRunCalls = 0;
	let publishCalls = 0;
	const transport = fakeTransport((argv) => {
		const preparation = exactPreparationResponse(argv);
		if (preparation !== undefined) return preparation;
		const command = argv.join(" ");
		if (command.endsWith(`commits/${headSha}?per_page=100&page=1`)) {
			return commandResult(
				JSON.stringify({
					sha: headSha,
					parents: [{ sha: baseSha }],
					files: [{ filename: "packages/coding-agent/CHANGELOG.md" }],
				}),
			);
		}
		if (command.endsWith(`/pulls/${pullRequest.number}`)) return commandResult(JSON.stringify(apiPull()));
		if (command.includes("/protection/required_status_checks")) {
			return commandResult(JSON.stringify({ checks: [{ context: "test (linux)", app_id: 15368 }] }));
		}
		if (command.includes("/rules/branches/main")) return commandResult("[]");
		if (command.includes("/check-runs")) {
			checkRunCalls += 1;
			return commandResult(
				JSON.stringify({
					check_runs:
						checkRunCalls < 3
							? []
							: [
									{
										id: 2,
										name: "test (linux)",
										status: "completed",
										conclusion: "success",
										html_url: "https://github.com/bastani-inc/atomic/actions/runs/2",
										app: { id: 15368 },
									},
								],
				}),
			);
		}
		if (command.includes("/status?")) return commandResult(JSON.stringify({ statuses: [] }));
		if (command.includes("/actions/workflows/publish.yml/runs")) {
			publishCalls += 1;
			return commandResult(
				JSON.stringify({
					workflow_runs:
						publishCalls < 2
							? []
							: [
									{
										id: 100,
										name: "Publish",
										display_title: "Publish 1.2.3",
										path: ".github/workflows/publish.yml",
										event: "push",
										head_branch: "1.2.3",
										head_sha: releaseSha,
										status: "completed",
										conclusion: "success",
										html_url: "https://github.com/bastani-inc/atomic/actions/runs/100",
										repository: { full_name: "bastani-inc/atomic" },
									},
								],
				}),
			);
		}
		throw new Error(`unexpected fake command: ${command}`);
	});
	const ctx = {
		inputs: { target_version: "1.2.3", release_kind: "release", base_ref: "main" },
		cwd: "/safe/fake/repository",
		releaseBoundaryOptions: {
			transport,
			clock: fakeClock(),
			requiredCheckIntervalMs: 1,
			requiredCheckTimeoutMs: 5,
			publishIntervalMs: 1,
			publishTimeoutMs: 5,
		},
		tool: async (
			name: string,
			_input: object,
			callback: (input: { readonly signal: AbortSignal }) => Promise<unknown>,
		) => {
			toolCalls.push(name);
			return await callback({ signal: controller.signal });
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
	assert.equal(checkRunCalls, 3);
	assert.equal(publishCalls, 2);
	assert.deepEqual(toolCalls, ["inspect-release-preparation", "wait-required-ci", "wait-publish-action"]);
	assert.deepEqual(taskCalls, ["merge-exact-head-and-sync-base", "cut-and-push-release-tag"]);
	assert.deepEqual(sideEffects, ["fake exact-head merge/base sync", "fake detached tag verification"]);
	assert.ok(transport.calls.every((argv) => argv[0] === "git" || argv[0] === "gh"));
	assert.ok(transport.signals.every((signal) => signal === controller.signal));
});

test("release-0.9.15 retry regression blocks a stale dirty checkout before reuse or mutation", async () => {
	const source = workflowSource();
	assert.match(source, /preparationInspection\.mode === "reuse"/u);
	assert.doesNotMatch(source, /git reset|reset --hard|push --force/u);
	const transport = fakeTransport((argv) => {
		const response = exactPreparationResponse(argv, " M packages/coding-agent/CHANGELOG.md");
		if (response !== undefined) return response;
		const command = argv.join(" ");
		if (command.endsWith(`commits/${headSha}?per_page=100&page=1`)) {
			return commandResult(
				JSON.stringify({
					sha: headSha,
					parents: [{ sha: baseSha }],
					files: [{ filename: "packages/coding-agent/CHANGELOG.md" }],
				}),
			);
		}
		throw new Error(`unexpected fake command: ${command}`);
	});

	let taskCalled = false;
	await assert.rejects(
		async () =>
			await publishRelease.run({
				inputs: { target_version: "1.2.3", release_kind: "release", base_ref: "main" },
				cwd: "/safe/fake/repository",
				releaseBoundaryOptions: { transport },
				tool: async (
					_name: string,
					_input: object,
					callback: (input: { readonly signal: AbortSignal }) => Promise<unknown>,
				) => await callback({ signal: new AbortController().signal }),
				task: async () => {
					taskCalled = true;
				},
			} as never),
		/not clean.*CHANGELOG\.md/u,
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
