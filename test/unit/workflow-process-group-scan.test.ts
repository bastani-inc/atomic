import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { scanProcessGroup } from "../../packages/workflows/src/workers/admission-host.js";

const OPEN_FILE_LIMIT = 64;
const PROCESSES = 400;
const GROUP = 4242;

const proc = vi.hoisted(() => ({ open: 0, enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
			if (!proc.enabled || args[0] !== "/proc") return actual.readdir(...args);
			return ["self", ...Array.from({ length: PROCESSES }, (_, index) => String(1000 + index))];
		}),
		readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
			const match = proc.enabled ? /^\/proc\/(\d+)\/stat$/.exec(String(args[0])) : null;
			if (match === null) return actual.readFile(...args);
			if (proc.open >= OPEN_FILE_LIMIT)
				throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
			proc.open++;
			try {
				await new Promise((resolve) => setImmediate(resolve));
				const pid = Number(match[1]);
				const group = pid % 10 === 0 ? GROUP : 1;
				return `${pid} (worker) ${group === GROUP ? "Z" : "S"} 1 ${group} ${group} 0 -1\n`;
			} finally {
				proc.open--;
			}
		}),
	};
});

afterEach(() => {
	proc.enabled = false;
	proc.open = 0;
});

test.skipIf(process.platform !== "linux")(
	"a process group scan stays complete on a host with more processes than it may open files at once",
	async () => {
		proc.enabled = true;

		const scan = await scanProcessGroup(GROUP);

		assert.equal(scan.complete, true, "every process was read");
		assert.equal(scan.members.size, PROCESSES / 10);
		assert.ok([...scan.members.values()].every((state) => state === "Z"));
	},
);
