import { describe, expect, it } from "vitest";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_MARK_FRAMES,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
	completeWorkingActivity,
	startWorkingActivity,
	workingLabelForActivity,
	workingLabelForTool,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("Atomic working status", () => {
	it("packs recognizable G1 topology into a stable two-row cumulative surface", () => {
		expect(ATOMIC_WORKING_FRAME_MS).toBe(240);
		expect(ATOMIC_WORKING_MARK_FRAMES).toHaveLength(12);
		for (const frame of ATOMIC_WORKING_MARK_FRAMES) {
			expect(frame).toHaveLength(2);
			expect(frame[0]!.length).toBe(frame[1]!.length);
		}
		for (let index = 1; index <= 6; index++) {
			const before = [...ATOMIC_WORKING_MARK_FRAMES[index - 1]!.join("")].filter((c) => c !== " ").length;
			const after = [...ATOMIC_WORKING_MARK_FRAMES[index]!.join("")].filter((c) => c !== " ").length;
			expect(after).toBeGreaterThanOrEqual(before);
		}
		expect(ATOMIC_WORKING_MARK_FRAMES[6]!.join("")).not.toContain("-");
		expect(ATOMIC_WORKING_MARK_FRAMES[7]!.join("")).toContain("-");
		expect(ATOMIC_WORKING_MARK_FRAMES[8]!.join("")).toContain("--");
		expect(ATOMIC_WORKING_MARK_FRAMES[9]!.join("")).toContain("--*");
		expect(ATOMIC_WORKING_MARK_FRAMES[10]).toEqual(ATOMIC_WORKING_MARK_FRAMES[9]);
		expect(ATOMIC_WORKING_MARK_FRAMES[11]).toEqual(ATOMIC_WORKING_MARK_FRAMES[9]);
	});

	it("samples the 240ms cadence and two rest frames", () => {
		expect(atomicWorkingFrame(0)).toBe(0);
		expect(atomicWorkingFrame(239)).toBe(0);
		expect(atomicWorkingFrame(240)).toBe(1);
		expect(atomicWorkingFrame(480)).toBe(2);
		expect(atomicWorkingFrame(2400)).toBe(10);
		expect(atomicWorkingFrame(2640)).toBe(11);
	});

	it("classifies reasoning and thinking as questioning defaults", () => {
		expect(workingLabelForActivity({ type: "reasoning" })).toBe("Questioning the defaults");
		expect(workingLabelForActivity({ type: "thinking" })).toBe("Questioning the defaults");
	});
	it.each([
		["read", undefined, "Checking the machinery"],
		["code_search", { query: "x" }, "Checking the machinery"],
		["get_search_content", { responseId: "r" }, "Checking the machinery"],
		["grep", "needle", "Checking the machinery"],
		["fetch_content", null, "Checking the machinery"],
		["edit", { input: "[src/a.ts#AAAA]\nreplace 1:\n+x" }, "Building assurance"],
		["edit", { input: "[docs/a.md#AAAA]\nreplace 1:\n+x\n[reports/out.txt#BBBB]\nreplace 1:\n+y" }, "Making it inspectable"],
		["write", { path: "src/parser.spec.ts" }, "Building assurance"],
		["write", { path: "specs/parser.spec.ts" }, "Making it inspectable"],
		["write", { path: "report.txt" }, "Making it inspectable"],
		["write", undefined, "Building assurance"],
		["edit", null, "Building assurance"],
		["bash", { command: "bunx vitest run x" }, "Demanding evidence"],
		["bash", { command: "bun run typecheck && tsc --noEmit" }, "Demanding evidence"],
		["bash", { command: "jest && eslint . && biome check ." }, "Demanding evidence"],
		["test", undefined, "Demanding evidence"],
		["workflow", { action: "run" }, "Proving the path"],
		["bash", { command: "echo progress dispatch" }, "On it"],
		["mystery", undefined, "On it"],
		["mystery", null, "On it"],
		["mystery", "primitive", "On it"],
	] as const)("classifies production %s schema without throwing", (tool, args, expected) => {
		expect(workingLabelForTool(tool, args)).toBe(expected);
	});

	it.each([
		["bun run test:unit", "Demanding evidence"],
		["bun test", "Demanding evidence"],
		["bunx vitest run", "Demanding evidence"],
		["AGENT=1 bun test", "Demanding evidence"],
		["env CI=1 bun run typecheck", "Demanding evidence"],
		["echo setup && bun run lint", "Demanding evidence"],
		["typecheck && lint", "Demanding evidence"],
		["cargo test", "Demanding evidence"],
		["go test ./...", "Demanding evidence"],
		["pytest -q", "Demanding evidence"],
		["python -m pytest tests", "Demanding evidence"],
		["CI=1 cargo test", "Demanding evidence"],
		["env CI=1 go test ./...", "Demanding evidence"],
		["echo setup && pytest", "Demanding evidence"],
		["echo setup; python -m pytest", "Demanding evidence"],
		["test -f file", "On it"],
		["[ -f file ]", "On it"],
		["echo x && test -d dir", "On it"],
		["echo cargo test", "On it"],
		["printf 'go test'", "On it"],
		["echo pytest", "On it"],
		["python -c \"print('pytest')\"", "On it"],
		["cargo build --message-format test", "On it"],
		["go env test", "On it"],
		["echo test", "On it"],
		["printf lint", "On it"],
		["echo vitest", "On it"],
		["git status | grep test", "On it"],
		["bun run build --label lint", "On it"],
		["bun run build", "On it"],
	] as const)("classifies shell command position: %s", (command, expected) => {
		expect(workingLabelForTool("bash", { command })).toBe(expected);
	});

	it.each([
		["run", "Proving the path"],
		["dispatch", "Proving the path"],
		["progress", "Proving the path"],
		["status", "Proving the path"],
		["send", "Proving the path"],
		["pause", "Proving the path"],
		["interrupt", "Proving the path"],
		["quit", "Proving the path"],
		["resume", "Proving the path"],
		["reload", "Proving the path"],
		["list", "On it"],
		["get", "On it"],
		["inputs", "On it"],
		["stages", "On it"],
		["stage", "On it"],
		["transcript", "On it"],
		["unknown", "On it"],
	] as const)("classifies workflow action %s", (action, expected) => {
		expect(workingLabelForTool("workflow", { action })).toBe(expected);
	});

	it("falls back for omitted workflow actions", () => {
		expect(workingLabelForTool("workflow", undefined)).toBe("On it");
		expect(workingLabelForTool("workflow", null)).toBe("On it");
	});

	it.each([
		[{ path: "src/report-generator.ts" }, "Building assurance"],
		[{ path: "src/openapi-spec-helper.ts" }, "Building assurance"],
		[{ path: "report.txt" }, "Making it inspectable"],
		[{ path: "src/parser.spec.ts" }, "Building assurance"],
		[{ path: "specs/parser.spec.ts" }, "Making it inspectable"],
		[{ path: "src/report.rs" }, "Building assurance"],
		[{ path: "src/spec.py" }, "Building assurance"],
		[{ path: "src/report.go" }, "Building assurance"],
		[{ path: "src/spec.sh" }, "Building assurance"],
		[{ path: "reports/report.rs" }, "Making it inspectable"],
		[{ input: "header\n[docs/usage.md#ABCD]   \r\nreplace 1:\n+x" }, "Making it inspectable"],
		[{ input: "[src/a.ts#A1B2]\nreplace 1:\n+x\n[reports/out.txt#c3d4]\t\r\nreplace 1:\n+y" }, "Making it inspectable"],
		[{ input: "[\"docs/design notes.md\"#ABCD]\nreplace 1:\n+x" }, "Making it inspectable"],
		[{ input: "['reports/result.txt'#C0DE]\nreplace 1:\n+x" }, "Making it inspectable"],
		[{ input: "[docs/a.md#ABC]\nreplace 1:\n+x" }, "Building assurance"],
		[{ input: "[docs/a.md#ABCDE]\nreplace 1:\n+x" }, "Building assurance"],
		[{ input: "[docs/a.md#nope]\nreplace 1:\n+x" }, "Building assurance"],
		[{ input: "[src/report-generator.ts#ABCD]\nreplace 1:\n+x\n[src/parser.spec.ts#1234]\nreplace 1:\n+y" }, "Building assurance"],
	] as const)("classifies production write/edit paths %#", (args, expected) => {
		const tool = "input" in args ? "edit" : "write";
		expect(workingLabelForTool(tool, args)).toBe(expected);
	});

	it("maintains ordered active labels and retains only successful verification", () => {
		const active = new Map<string, string>();
		expect(startWorkingActivity(active, "a", "Checking the machinery")).toBe("Checking the machinery");
		expect(startWorkingActivity(active, "b", "Building assurance")).toBe("Building assurance");
		expect(startWorkingActivity(active, "a", "Checking the machinery")).toBe("Building assurance");
		expect(completeWorkingActivity(active, "b", false)).toBe("Checking the machinery");
		expect(completeWorkingActivity(active, "a", false)).toBeUndefined();
		startWorkingActivity(active, "v", "Demanding evidence");
		expect(completeWorkingActivity(active, "v", false)).toBe("Demanding evidence");
		startWorkingActivity(active, "bad", "Demanding evidence");
		expect(completeWorkingActivity(active, "bad", true)).toBeUndefined();
		expect(completeWorkingActivity(active, "unknown", false)).toBeUndefined();
	});

	it("renders exactly two rows and one label at 100 and 64 columns", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const lines = new AtomicWorkingStatusComponent({ frame: 9, message: "Questioning the defaults", spinnerColor: String, messageColor: String }).render(width).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines.join("\n").match(/Questioning the defaults/g)).toHaveLength(1);
			expect(lines.every((line) => line.length <= width)).toBe(true);
		}
	});

	it("hides atomically when the full mark and label cannot fit", () => {
		expect(new AtomicWorkingStatusComponent({ frame: 9, message: "Questioning the defaults", spinnerColor: String, messageColor: String }).render(20)).toEqual([]);
	});

	it("main status-container harness stays compact beside growing history at 100 and 64 columns", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const root = new Container();
			root.addChild(new Text("history-1\nhistory-2", 0, 0));
			root.addChild(new AtomicWorkingStatusComponent({ frame: 9, message: "On it", spinnerColor: String, messageColor: String }));
			const lines = root.render(width).map(plain);
			expect(lines.slice(0, 2).map((line) => line.trimEnd())).toEqual(["history-1", "history-2"]);
			expect(lines.slice(2)).toHaveLength(2);
			expect(lines.join("\n").match(/On it/g)).toHaveLength(1);
			expect(lines.every((line) => line.length <= width)).toBe(true);
		}
	});
	it("preserves explicit extension indicator overrides", () => {
		initTheme("dark");
		const loader = new AtomicWorkingLoader({ requestRender: () => {} } as never, String, String, "Extension status", { frames: ["X"] });
		expect(loader.render(64).map(plain).join("\n")).toContain("X Extension status");
		loader.setIndicator();
		expect(loader.render(64)).toHaveLength(2);
		loader.stop();
	});
});
