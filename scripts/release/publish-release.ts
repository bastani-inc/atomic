import { canonicalReleaseBaseRef } from "../release-base.js";
import { argumentsFor, ReleaseBlocked, releaseCli } from "./cli.js";
import {
	checkChangelogDiff,
	createReleaseBoundary,
	mergeExactHead,
	PUBLISH_TIMEOUT_MS,
	RELEASE_REPOSITORY,
	REQUIRED_CHECK_TIMEOUT_MS,
	validateReleaseRequest,
} from "./publish-release-gates.js";

const FINAL_INSPECTION_GRACE_MS = 30_000;
const request = "--version V [--kind release|prerelease]";
const commands = {
	validate: `${request} [--base REF]`,
	"inspect-preparation": `${request} [--base REF]`,
	"check-changelog-diff": "--base REF",
	"wait-required-checks": `${request} --base REF --pr N --head SHA [--timeout-ms N]`,
	"merge-exact-head": "--pr N --head SHA --base REF [--version V]",
	"wait-publish-run": `${request} --sha SHA [--timeout-ms N]`,
};

function sha(value: string) {
	if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("Expected a full lowercase commit SHA.");
	return value;
}

async function run(args: string[], interrupted: AbortSignal) {
	const { command, flags, help } = argumentsFor(commands, args);
	if (help) return help;
	const arg = (key: string) => {
		const value = flags[key];
		if (typeof value !== "string" || !value) throw new Error(`Missing --${key}.`);
		return value;
	};
	const baseRef = typeof flags.base === "string" ? flags.base : "main";
	canonicalReleaseBaseRef(baseRef);
	const cwd = process.cwd();
	const validated = () => {
		const version = arg("version");
		const kind = flags.kind ?? (version.includes("-") ? "prerelease" : "release");
		if (kind !== "release" && kind !== "prerelease") throw new Error("Expected --kind release or prerelease.");
		return validateReleaseRequest(kind, version);
	};
	const pullRequest = () => {
		const raw = arg("pr");
		const number = Number(raw);
		if (!Number.isSafeInteger(number) || number < 1 || String(number) !== raw)
			throw new Error("Expected a positive PR number.");
		return { url: `https://github.com/${RELEASE_REPOSITORY}/pull/${number}`, number, headSha: sha(arg("head")) };
	};
	if (command === "validate") return { status: "passed", ...validated(), baseRef };
	if (command === "merge-exact-head" || command === "check-changelog-diff" || command === "wait-required-checks")
		arg("base");
	const max =
		command === "wait-publish-run"
			? PUBLISH_TIMEOUT_MS
			: command === "wait-required-checks"
				? REQUIRED_CHECK_TIMEOUT_MS
				: 2 * 60_000;
	const timeout = flags["timeout-ms"] === undefined ? max : Number(arg("timeout-ms"));
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > max)
		throw new Error(`--timeout-ms must be between 1 and ${max}.`);
	const polling = command === "wait-required-checks" || command === "wait-publish-run";
	const hardTimeout = polling ? timeout + FINAL_INSPECTION_GRACE_MS : timeout;
	const signal = AbortSignal.any([interrupted, AbortSignal.timeout(hardTimeout)]);
	const boundary = createReleaseBoundary(cwd, { requiredCheckTimeoutMs: timeout, publishTimeoutMs: timeout });
	try {
		if (command === "check-changelog-diff") return await checkChangelogDiff(cwd, baseRef, signal);
		if (command === "merge-exact-head")
			return await mergeExactHead({
				cwd,
				baseRef,
				pullRequest: pullRequest(),
				release: flags.version === undefined ? undefined : validated(),
				dryRun: flags["dry-run"] === true,
				signal,
				syncSignal: interrupted,
			});
		const release = validated();
		if (command === "inspect-preparation") {
			const p = await boundary.inspectPreparation({ cwd, release, baseRef, signal });
			return p.mode === "reuse"
				? { status: "passed", mode: p.mode, pr: p.pullRequest, changedFiles: p.changedFiles, summary: p.summary }
				: { status: "passed", ...p };
		}
		const result =
			command === "wait-publish-run"
				? await boundary.waitForPublish({ release, releaseSha: sha(arg("sha")), signal })
				: await boundary.waitForRequiredChecks({ release, baseRef, pullRequest: pullRequest(), signal });
		if (result.status !== "passed")
			throw new ReleaseBlocked(
				[result.summary, result.evidenceUrl].filter(Boolean).join(" "),
				result.lastObservation,
			);
		return result;
	} catch (error) {
		if (interrupted.aborted) throw new ReleaseBlocked("Release gate interrupted.");
		if (signal.aborted && error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
			throw new ReleaseBlocked(`${command} timed out after ${timeout} ms.`);
		throw error;
	}
}

if (import.meta.main) await releaseCli((signal) => run(process.argv.slice(2), signal));
