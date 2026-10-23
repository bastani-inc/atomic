import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createJiti } from "jiti";

const loader = createJiti(import.meta.url, { fsCache: false });
const { resolveRunJournal } = await loader.import(fileURLToPath(new URL("../../packages/workflows/src/durable/journal/resolution.ts", import.meta.url)));
const { SqlResourceAdmission } = await loader.import(fileURLToPath(new URL("../../packages/workflows/src/workers/resource-admission.ts", import.meta.url)));
const [path, holder] = process.argv.slice(2);
const journal = await resolveRunJournal({ journal: { path } });
const admission = await SqlResourceAdmission.open(journal, { root: "root", holder, limits: { session: 2, process: 1 } });
await admission.acquire("session");
let groupId;
if (holder === "coordinator") {
	const { createAgentSession, withResourceAdmission } = await loader.import(fileURLToPath(new URL("../../packages/coding-agent/src/core/sdk.ts", import.meta.url)));
	const { SessionManager } = await loader.import(fileURLToPath(new URL("../../packages/coding-agent/src/core/session-manager.ts", import.meta.url)));
	const { poolStageOptions } = await loader.import(fileURLToPath(new URL("./pool-stage-options.ts", import.meta.url)));
	const cwd = dirname(path);
	const { session } = await createAgentSession({ ...await poolStageOptions(cwd, false, 0), sessionManager: SessionManager.inMemory(cwd) });
	const { supervisor, owner } = session.getAgentTaskHost().ownerBinding;
	const started = await withResourceAdmission(admission, () => supervisor.startCommandTask(owner, { kind: "command", command: "trap '' HUP; echo $$; exec sleep 300", cwd, env: {}, terminal: { kind: "pipe" } }, crypto.randomUUID()));
	if (!started.ok) throw new Error(started.error.message);
	while (!groupId) {
		const page = await supervisor.readTaskOutput(started.value, { start: "0", maximumBytes: 1024 });
		if (!page.ok) throw new Error(page.error.message);
		groupId = Number(Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString().trim());
		if (!groupId) await new Promise((resolve) => setTimeout(resolve, 10));
	}
	void admission.acquire("session");
	const waiting = AbortSignal.timeout(5000);
	while (!(await admission.inspect()).some((permit) => permit.holder === holder && permit.state === "waiting")) {
		waiting.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
process.send({ ready: true, groupId });
setInterval(() => {}, 1000);
