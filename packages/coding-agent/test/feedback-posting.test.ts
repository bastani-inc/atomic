import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	applyFeedbackRequestMarker,
	createGitHubFeedbackPostHandler,
	type FeedbackPostingDependencies,
	feedbackRequestMarker,
	prepareFeedbackRequestPreview,
} from "../src/extensions/feedback/posting.ts";
import type { FeedbackPostRequest } from "../src/extensions/feedback/preview.ts";
import { FEEDBACK_BODY_MAX_CHARACTERS } from "../src/extensions/feedback/privacy.ts";

const TOKEN = "github_pat_synthetic_test_token_1234567890";

function request(kind: "bug" | "enhancement" = "bug"): FeedbackPostRequest {
	return {
		requestId: "request-123",
		draft: applyFeedbackRequestMarker(
			{
				repository: "bastani-inc/atomic",
				kind,
				label: kind,
				title: "[feedback E2E] Synthetic report",
				body: "## What happened?\n\nSynthetic report",
			},
			"request-123",
		),
	};
}

function result(stdout = "", code = 0, killed = false, stderr = "") {
	return { stdout, stderr, code, killed };
}

function dependencies(
	overrides: Partial<FeedbackPostingDependencies> = {},
): FeedbackPostingDependencies & { bodies: string[]; calls: Array<{ command: string; args: string[] }> } {
	const bodies: string[] = [];
	const calls: Array<{ command: string; args: string[] }> = [];
	return {
		bodies,
		calls,
		env: {},
		exec: async (command, args) => {
			calls.push({ command, args });
			return result();
		},
		fetch: async () => new Response(null, { status: 500 }),
		writeBodyFile: async (body) => {
			bodies.push(body);
			return { path: "/synthetic/feedback-body.md", remove: async () => {} };
		},
		...overrides,
	};
}

describe("feedback GitHub posting", () => {
	test("labels a successfully created bug through ready authenticated gh with structured safe arguments", async () => {
		const deps = dependencies({
			exec: async (command, args) => {
				deps.calls.push({ command, args });
				if (args[0] === "auth" || (args[0] === "issue" && args[1] === "edit")) return result();
				return result("https://github.com/bastani-inc/atomic/issues/1234\n");
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		const payload = request();
		const posted = await post(payload);

		assert.deepEqual(posted, { status: "success", url: "https://github.com/bastani-inc/atomic/issues/1234" });
		assert.deepEqual(
			deps.calls.map((call) => call.args.slice(0, 2)),
			[
				["auth", "status"],
				["issue", "create"],
				["issue", "edit"],
			],
		);
		const createArgs = deps.calls[1]?.args ?? [];
		assert.deepEqual(createArgs.slice(0, 6), [
			"issue",
			"create",
			"--repo",
			"bastani-inc/atomic",
			"--title",
			payload.draft.title,
		]);
		assert.deepEqual(createArgs.slice(6), ["--body-file", "/synthetic/feedback-body.md"]);
		assert.deepEqual(deps.calls[2]?.args, [
			"issue",
			"edit",
			"1234",
			"--repo",
			"bastani-inc/atomic",
			"--add-label",
			"bug",
		]);
		assert.doesNotMatch(JSON.stringify(deps.calls), new RegExp(`${TOKEN}|${payload.draft.body}`, "u"));
		assert.deepEqual(deps.bodies, [payload.draft.body]);
		assert.match(payload.draft.body, /<!-- atomic-feedback-request:request-123;kind:bug -->$/u);
	});

	test("labels a successful REST enhancement with the exact kind and keeps the token header-only", async () => {
		const authorizations: string[] = [];
		let postedBody = "";
		let labelUrl = "";
		let labelBody = "";
		const deps = dependencies({
			env: { GH_TOKEN: TOKEN, GITHUB_TOKEN: "github_pat_secondary_synthetic_1234567890" },
			exec: async (command, args) => {
				deps.calls.push({ command, args });
				return result("", 1, false, TOKEN);
			},
			fetch: async (input, init) => {
				authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
				if (String(input).endsWith("/issues")) {
					postedBody = String(init?.body ?? "");
					return new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/1235" }), {
						status: 201,
						headers: { "content-type": "application/json" },
					});
				}
				labelUrl = String(input);
				labelBody = String(init?.body ?? "");
				return new Response(null, { status: 200 });
			},
		});
		const payload = request("enhancement");
		const posted = await createGitHubFeedbackPostHandler(deps)(payload);

		assert.deepEqual(authorizations, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
		assert.doesNotMatch(JSON.stringify(deps.calls), new RegExp(TOKEN, "u"));
		assert.doesNotMatch(payload.draft.body, new RegExp(TOKEN, "u"));
		assert.doesNotMatch(postedBody, new RegExp(TOKEN, "u"));
		assert.deepEqual(posted, { status: "success", url: "https://github.com/bastani-inc/atomic/issues/1235" });
		assert.deepEqual(JSON.parse(postedBody), { title: payload.draft.title, body: payload.draft.body });
		assert.equal(labelUrl, "https://api.github.com/repos/bastani-inc/atomic/issues/1235/labels");
		assert.deepEqual(JSON.parse(labelBody), { labels: ["enhancement"] });
		assert.doesNotMatch(labelBody, new RegExp(TOKEN, "u"));
	});

	test("keeps the created issue successful when an external reporter cannot apply the label", async () => {
		// #2799: default-branch automation labels later, so a best-effort permission denial is non-fatal.
		const ghDeps = dependencies({
			exec: async (command, args) => {
				ghDeps.calls.push({ command, args });
				if (args[0] === "auth") return result();
				if (args[0] === "issue" && args[1] === "create") {
					return result("https://github.com/bastani-inc/atomic/issues/1236\n");
				}
				return result("", 1, false, "Resource not accessible by integration");
			},
		});
		assert.deepEqual(await createGitHubFeedbackPostHandler(ghDeps)(request("bug")), {
			status: "success",
			url: "https://github.com/bastani-inc/atomic/issues/1236",
		});
		assert.deepEqual(
			ghDeps.calls.map((call) => call.args.slice(0, 2)),
			[
				["auth", "status"],
				["issue", "create"],
				["issue", "edit"],
			],
		);

		let restCalls = 0;
		const restDeps = dependencies({
			env: { GH_TOKEN: TOKEN },
			exec: async () => result("", 1),
			fetch: async (_input, init) => {
				restCalls += 1;
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
				return restCalls === 1
					? new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/1237" }), {
							status: 201,
						})
					: new Response(null, { status: 403 });
			},
		});
		assert.deepEqual(await createGitHubFeedbackPostHandler(restDeps)(request("enhancement")), {
			status: "success",
			url: "https://github.com/bastani-inc/atomic/issues/1237",
		});
		assert.equal(restCalls, 2);
	});

	test("retains actionable failures without exposing tokens from command, response, or exceptions", async () => {
		for (const setup of [
			dependencies({ exec: async () => result("", 1), env: {} }),
			dependencies({
				exec: async () => result("", 1),
				env: { GH_TOKEN: TOKEN },
				fetch: async () => new Response(TOKEN, { status: 401 }),
			}),
			dependencies({
				exec: async () => result("", 1),
				env: { GH_TOKEN: TOKEN },
				fetch: async () => {
					throw new Error(TOKEN);
				},
			}),
		]) {
			const outcome = await createGitHubFeedbackPostHandler(setup)(request());
			assert.notEqual(outcome.status, "success");
			assert.doesNotMatch(JSON.stringify(outcome), new RegExp(TOKEN, "u"));
		}
	});

	test("reconciles an uncertain gh creation by stable marker before retrying", async () => {
		let createCalls = 0;
		let listCalls = 0;
		let labelCalls = 0;
		const payload = request();
		const deps = dependencies({
			exec: async (command, args) => {
				deps.calls.push({ command, args });
				if (args[0] === "auth") return result();
				if (args[0] === "issue" && args[1] === "create") {
					createCalls += 1;
					return result("", 1, true);
				}
				if (args[0] === "issue" && args[1] === "edit") {
					labelCalls += 1;
					return result();
				}
				listCalls += 1;
				return result(
					JSON.stringify([{ url: "https://github.com/bastani-inc/atomic/issues/1236", body: payload.draft.body }]),
				);
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		assert.equal((await post(payload)).status, "uncertain");
		assert.deepEqual(await post(payload), {
			status: "success",
			url: "https://github.com/bastani-inc/atomic/issues/1236",
		});
		assert.equal(createCalls, 1);
		assert.equal(listCalls, 1);
		assert.equal(labelCalls, 1);
	});

	test("does not retry creation when uncertain reconciliation itself is unavailable", async () => {
		let creates = 0;
		const deps = dependencies({
			exec: async (_command, args) => {
				if (args[0] === "auth") return result();
				if (args[0] === "issue" && args[1] === "create") {
					creates += 1;
					return result("", 1, true);
				}
				return result("", 1);
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		assert.equal((await post(request())).status, "uncertain");
		assert.equal((await post(request())).status, "uncertain");
		assert.equal(creates, 1);
	});

	test("rejects malformed success responses and never accepts a foreign repository URL", async () => {
		for (const stdout of ["created\n", "https://github.com/other/repo/issues/1\n"]) {
			const deps = dependencies({
				exec: async (_command, args) => (args[0] === "auth" ? result() : result(stdout)),
			});
			assert.equal((await createGitHubFeedbackPostHandler(deps)(request())).status, "uncertain");
		}
	});

	test("uses GITHUB_TOKEN when GH_TOKEN is absent", async () => {
		let authorization = "";
		const deps = dependencies({
			env: { GITHUB_TOKEN: TOKEN },
			exec: async () => result("", 1),
			fetch: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/1237" }), {
					status: 201,
				});
			},
		});
		assert.equal((await createGitHubFeedbackPostHandler(deps)(request())).status, "success");
		assert.equal(authorization, `Bearer ${TOKEN}`);
	});

	test("classifies REST permission, rate-limit, validation, server, and malformed responses without success", async () => {
		const responses = [
			new Response(null, { status: 403 }),
			new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
			new Response(null, { status: 422 }),
			new Response(null, { status: 500 }),
			new Response(JSON.stringify({ html_url: "not-an-issue" }), { status: 201 }),
		];
		const statuses: string[] = [];
		for (const response of responses) {
			const deps = dependencies({
				env: { GH_TOKEN: TOKEN },
				exec: async () => result("", 1),
				fetch: async () => response,
			});
			const outcome = await createGitHubFeedbackPostHandler(deps)(request());
			statuses.push(outcome.status);
			assert.doesNotMatch(JSON.stringify(outcome), new RegExp(TOKEN, "u"));
		}
		assert.deepEqual(statuses, ["failure", "failure", "failure", "uncertain", "uncertain"]);
	});

	test("reconciles an uncertain REST creation before retrying without relying on a reporter login", async () => {
		const payload = request();
		let posts = 0;
		let gets = 0;
		let labels = 0;
		let reconciliationUrl = "";
		const deps = dependencies({
			env: { GH_TOKEN: TOKEN },
			exec: async () => result("", 1),
			fetch: async (input, init) => {
				if (String(input).endsWith("/issues") && init?.method === "POST") {
					posts += 1;
					throw new Error("synthetic network timeout");
				}
				if (init?.method === "POST") {
					labels += 1;
					return new Response(null, { status: 200 });
				}
				gets += 1;
				reconciliationUrl = String(input);
				return new Response(
					JSON.stringify([
						{ html_url: "https://github.com/bastani-inc/atomic/issues/1238", body: payload.draft.body },
					]),
					{ status: 200 },
				);
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		assert.equal((await post(payload)).status, "uncertain");
		assert.deepEqual(await post(payload), {
			status: "success",
			url: "https://github.com/bastani-inc/atomic/issues/1238",
		});
		assert.equal(posts, 1);
		assert.equal(gets, 1);
		assert.equal(reconciliationUrl, "https://api.github.com/repos/bastani-inc/atomic/issues?state=all&per_page=100");
		assert.equal(labels, 1);
	});

	test("reconciles an uncertain REST server response before retrying", async () => {
		// #2799: a server error may arrive after GitHub accepted the issue, so Retry must reconcile first.
		const payload = request();
		let posts = 0;
		let gets = 0;
		let labels = 0;
		const deps = dependencies({
			env: { GH_TOKEN: TOKEN },
			exec: async () => result("", 1),
			fetch: async (input, init) => {
				if (String(input).endsWith("/issues") && init?.method === "POST") {
					posts += 1;
					return new Response(null, { status: 500 });
				}
				if (init?.method === "POST") {
					labels += 1;
					return new Response(null, { status: 200 });
				}
				gets += 1;
				return new Response(
					JSON.stringify([
						{ html_url: "https://github.com/bastani-inc/atomic/issues/1239", body: payload.draft.body },
					]),
					{ status: 200 },
				);
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		assert.equal((await post(payload)).status, "uncertain");
		assert.deepEqual(await post(payload), {
			status: "success",
			url: "https://github.com/bastani-inc/atomic/issues/1239",
		});
		assert.equal(posts, 1);
		assert.equal(gets, 1);
		assert.equal(labels, 1);
	});

	test("coalesces duplicate active requests and caches the created URL", async () => {
		let creates = 0;
		let finish: ((value: ReturnType<typeof result>) => void) | undefined;
		const deps = dependencies({
			exec: async (_command, args) => {
				if (args[0] === "auth" || (args[0] === "issue" && args[1] === "edit")) return result();
				creates += 1;
				return await new Promise((resolve) => {
					finish = resolve;
				});
			},
		});
		const post = createGitHubFeedbackPostHandler(deps);
		const first = post(request());
		const duplicate = post(request());
		while (finish === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
		finish(result("https://github.com/bastani-inc/atomic/issues/1239\n"));
		assert.deepEqual(await first, await duplicate);
		assert.equal((await post(request())).status, "success");
		assert.equal(creates, 1);
	});
});

describe("feedback request marker", () => {
	test("is deterministic, non-privileged, and regenerated once after editing", () => {
		const draft = request().draft;
		const edited = applyFeedbackRequestMarker({ ...draft, body: `${draft.body}\n\nEdited` }, "request-123");
		assert.equal(edited.body.split("<!-- atomic-feedback-request:").length - 1, 1);
		assert.equal(edited.body.endsWith(feedbackRequestMarker("request-123", "bug")), true);
		assert.match(edited.body, /Edited/u);
		assert.doesNotMatch(feedbackRequestMarker("request-123", "bug"), /label|permission|token/iu);
	});

	test("keeps the marker inside the body limit and discloses required truncation", () => {
		const preview = prepareFeedbackRequestPreview(
			{
				draft: {
					repository: "bastani-inc/atomic",
					kind: "enhancement",
					label: "enhancement",
					title: "Bounded report",
					body: "x".repeat(FEEDBACK_BODY_MAX_CHARACTERS),
				},
				replacements: [],
			},
			"bounded-request",
		);
		assert.equal(preview.draft.body.length, FEEDBACK_BODY_MAX_CHARACTERS);
		assert.equal(preview.draft.body.endsWith(feedbackRequestMarker("bounded-request", "enhancement")), true);
		assert.equal(preview.replacements.at(-1)?.kind, "size-limit");
	});
});
