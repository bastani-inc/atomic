/**
 * Real stage-chat terminal evidence (Node standard library; requires bun and tmux on PATH).
 * Run from any directory after the repository build:
 * node test/fixtures/stage-chat-skill-driver.mjs --evidence-dir /tmp/s6-fresh --columns 80 --rows 24
 * Executes the TypeScript fixture directly. Never bundles its transitive dependencies.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const HELP = "Usage: node test/fixtures/stage-chat-skill-driver.mjs --evidence-dir <fresh-directory> [--columns 80] [--rows 24]";
const BARRIER_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;
const { values } = parseArgs({
	options: {
		"evidence-dir": { type: "string" },
		columns: { type: "string", default: "80" },
		rows: { type: "string", default: "24" },
		help: { type: "boolean", default: false },
	},
	strict: true,
});
if (values.help) {
	console.log(HELP);
} else {
	assert.ok(values["evidence-dir"], HELP);
	const columns = Number(values.columns);
	const rows = Number(values.rows);
	assert.ok(Number.isInteger(columns) && columns >= 48, "--columns must be an integer >= 48");
	assert.ok(Number.isInteger(rows) && rows >= 16, "--rows must be an integer >= 16");
	await run(resolve(values["evidence-dir"]), columns, rows);
}

async function run(directory, columns, rows) {
	mkdirSync(dirname(directory), { recursive: true });
	mkdirSync(directory); // Refuse evidence reuse, including on a failed previous run.
	const fixtureDirectory = join(directory, "fixture");
	const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const fixture = join(cwd, "test/fixtures/stage-chat-skill-terminal.ts");
	const nonce = randomUUID();
	const session = `s6-skills-${nonce}`;
	const barriersPath = join(fixtureDirectory, "barriers.jsonl");
	const stderrPath = join(directory, "fixture-stderr.log");
	const log = (message) => {
		appendFileSync(join(directory, "assertions.log"), `${message}\n`);
		console.log(message);
	};
	const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8", timeout: EXIT_TIMEOUT_MS });
	const alive = () => spawnSync("tmux", ["has-session", "-t", session], { timeout: EXIT_TIMEOUT_MS }).status === 0;
	const records = (path) => {
		if (!existsSync(path)) return [];
		const text = readFileSync(path, "utf8");
		// A writer's partial final record is not yet a barrier.
		return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(JSON.parse);
	};
	let revision = -1;
	const wait = async (label, predicate) => {
		const deadline = Date.now() + BARRIER_TIMEOUT_MS;
		while (Date.now() < deadline) {
			for (const item of records(barriersPath)) {
				assert.equal(item.runId, nonce, "Evidence must belong to this fixture run");
				if (Number(item.revision) > revision && predicate(item.evidence, item)) {
					revision = Number(item.revision);
					log(`PASS ${label}: rendered revision ${revision}`);
					return item.evidence;
				}
			}
			assert.ok(alive(), `Fixture exited before ${label}; inspect fixture-stderr.log`);
			await poll(POLL_INTERVAL_MS);
		}
		throw new Error(`Deadline waiting for ${label}`);
	};
	const rendered = (evidence) => evidence.renderedLines.map(stripVTControlCharacters).join("\n");
	const capture = (name, pattern) => {
		const text = tmux("capture-pane", "-t", session, "-p");
		writeFileSync(join(directory, `${name}.txt`), text);
		writeFileSync(join(directory, `${name}.ansi`), tmux("capture-pane", "-t", session, "-p", "-e"));
		assert.match(text, pattern);
		log(`PASS actual tmux capture ${name}`);
		return text;
	};
	const type = async (text) => {
		tmux("send-keys", "-t", session, "-l", "--", text);
		return wait(`composer ${text}`, (evidence) => evidence.editorText === text);
	};
	const awaitExit = async () => {
		const deadline = Date.now() + EXIT_TIMEOUT_MS;
		while (alive() && Date.now() < deadline) await poll(POLL_INTERVAL_MS);
		return !alive();
	};
	// tmux's command is parsed by the user's POSIX shell. Quote every path/argument.
	const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
	try {
		tmux("-V");
		execFileSync("bun", ["--version"], { timeout: EXIT_TIMEOUT_MS });
		const command = `exec bun ${quote(fixture)} --evidence-dir ${quote(fixtureDirectory)} --run-id ${quote(nonce)} 2>${quote(stderrPath)}`;
		tmux("new-session", "-d", "-s", session, "-c", cwd, "-x", String(columns), "-y", String(rows), "-e", "ATOMIC_REDUCED_MOTION=1", command);
		const ready = await wait("ready", (_evidence, item) => item.barrier === "ready");
		assert.equal(ready.columns, columns);
		assert.equal(ready.rows, rows);
		assert.ok(ready.stageId && ready.sessionId);
		const initialMessages = ready.userMessages;
		for (const [index, command] of ["/tasks", "/tasks detail 7"].entries()) {
			await type(command);
			tmux("send-keys", "-t", session, "Enter");
			const local = await wait(`local ${command}`, (evidence) => evidence.editorText === "" && rendered(evidence).includes("Task inspection is unavailable"));
			assert.deepEqual(local.userMessages, initialMessages);
			assert.deepEqual(local.steering, []);
			assert.deepEqual(local.followUp, []);
			capture(`tasks-${index + 1}`, /Task inspection is unavailable/);
		}
		const typedSkill = await type("/skill:fi");
		const sourcePattern = /skill:fixture\s+\[p:npm:stage-projec/;
		if (!sourcePattern.test(rendered(typedSkill))) {
			await wait("suggestions", (evidence) => evidence.editorText === "/skill:fi" && sourcePattern.test(rendered(evidence)));
		}
		const suggestions = capture("suggestions", sourcePattern);
		assert.match(suggestions, /skill:fixture@project\s+\[p:npm:stage-projec/);
		assert.match(suggestions, /skill:fixture@user\s+\[u:npm:stage-user\]/);
		assert.doesNotMatch(suggestions, /main-project/);
		tmux("send-keys", "-t", session, "Tab");
		await wait("selected", (evidence) => evidence.editorText === "/skill:fixture ");
		tmux("send-keys", "-t", session, "-l", "--", "tmux-args");
		await wait("arguments", (evidence) => evidence.editorText === "/skill:fixture tmux-args");
		tmux("send-keys", "-t", session, "Enter");
		await wait("invoked", (evidence) => evidence.editorText === "" && rendered(evidence).includes("Observed fixture from stage-project"));
		capture("invoked", /Observed fixture from stage-project/);
		await type("/skill:fixture@user follow-up");
		tmux("send-keys", "-t", session, "C-f");
		await wait("follow-up", (evidence) => evidence.editorText === "" && rendered(evidence).includes("Observed fixture@user from stage-user"));
		capture("follow-up", /Observed fixture@user from stage-user/);
		tmux("send-keys", "-t", session, "C-c");
		assert.ok(await awaitExit(), "Fixture must exit after Ctrl+C");
		const barriers = records(barriersPath);
		const events = records(join(fixtureDirectory, "events.jsonl"));
		assert.ok(barriers.some((item) => item.barrier === "stopped" && item.evidence.disposed));
		assert.ok(barriers.every((item) => item.runId === nonce && item.evidence.sessionId === ready.sessionId && item.evidence.stageId === ready.stageId));
		assert.ok(events.every((item) => item.runId === nonce && item.sessionId === ready.sessionId));
		const messages = (type) => events.filter((item) => item.event.type === type && item.event.message.role === "user").map((item) => item.event.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
		const starts = messages("message_start");
		assert.equal(starts.length, 2, "Exactly two skill messages; no /tasks model delivery or duplicate raw command");
		const location = / location="([^"]+)"/.exec(starts[0])?.[1];
		assert.ok(location);
		const skillRoot = dirname(dirname(dirname(location)));
		const expected = [
			["fixture", "stage-project", "STAGE SKILL BODY. Read references/check.md relative to this skill.", "tmux-args"],
			["fixture@user", "stage-user", "STAGE USER ALTERNATIVE.", "follow-up"],
		].map(([name, source, body, args]) => {
			const path = join(skillRoot, source, "fixture", "SKILL.md");
			const candidate = `skill_${createHash("sha256").update(path).digest("hex").slice(0, 20)}`;
			return `<skill name="${name}" location="${path}" candidate="${candidate}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>\n\n${args}`;
		});
		assert.deepEqual(starts, expected);
		assert.deepEqual(messages("message_end"), expected);
		assert.deepEqual(barriers.filter((item) => item.evidence.userMessages).at(-1).evidence.userMessages, [...initialMessages, ...expected]);
		log("PASS exact selectors/candidates/locations/base directories/bodies/arguments; one expansion and message per command; no /tasks delivery");
		log("PASS stable run/stage/session identity; disposed barrier and tmux absence");
	} catch (error) {
		writeFileSync(join(directory, "failure.log"), `${error.stack ?? error}\n`);
		if (alive()) {
			writeFileSync(join(directory, "failure-pane.txt"), tmux("capture-pane", "-t", session, "-p", "-S", "-"));
		}
		throw error;
	} finally {
		if (alive()) {
			tmux("send-keys", "-t", session, "C-c");
			if (!(await awaitExit())) {
				tmux("kill-session", "-t", session);
				appendFileSync(join(directory, "failure.log"), "Fixture required forced tmux cleanup after graceful exit deadline.\n");
			}
			assert.ok(!alive(), "Dedicated tmux session survived cleanup");
		}
	}
}
