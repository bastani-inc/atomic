import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	allStepsComplete,
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "../examples/extensions/plan-mode/utils.js";

describe("isSafeCommand", () => {
	describe("safe commands", () => {
		it("allows basic read commands", () => {
			expect(isSafeCommand("ls -la")).toBe(true);
			expect(isSafeCommand("cat file.txt")).toBe(true);
			expect(isSafeCommand("head -n 10 file.txt")).toBe(true);
			expect(isSafeCommand("tail -f log.txt")).toBe(true);
			expect(isSafeCommand("grep pattern file")).toBe(true);
			expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		});

		it("allows git read commands", () => {
			expect(isSafeCommand("git status")).toBe(true);
			expect(isSafeCommand("git log --oneline")).toBe(true);
			expect(isSafeCommand("git diff")).toBe(true);
			expect(isSafeCommand("git branch")).toBe(true);
		});

		it("allows npm/yarn read commands", () => {
			expect(isSafeCommand("npm list")).toBe(true);
			expect(isSafeCommand("npm outdated")).toBe(true);
			expect(isSafeCommand("yarn info react")).toBe(true);
		});

		it("allows other safe commands", () => {
			expect(isSafeCommand("pwd")).toBe(true);
			expect(isSafeCommand("echo hello")).toBe(true);
			expect(isSafeCommand("wc -l file.txt")).toBe(true);
			expect(isSafeCommand("du -sh .")).toBe(true);
			expect(isSafeCommand("df -h")).toBe(true);
		});
	});

	describe("destructive commands", () => {
		it("blocks file modification commands", () => {
			expect(isSafeCommand("rm file.txt")).toBe(false);
			expect(isSafeCommand("rm -rf dir")).toBe(false);
			expect(isSafeCommand("mv old new")).toBe(false);
			expect(isSafeCommand("cp src dst")).toBe(false);
			expect(isSafeCommand("mkdir newdir")).toBe(false);
			expect(isSafeCommand("touch newfile")).toBe(false);
		});

		it("blocks git write commands", () => {
			expect(isSafeCommand("git add .")).toBe(false);
			expect(isSafeCommand("git commit -m 'msg'")).toBe(false);
			expect(isSafeCommand("git push")).toBe(false);
			expect(isSafeCommand("git checkout main")).toBe(false);
			expect(isSafeCommand("git reset --hard")).toBe(false);
		});

		it("blocks package manager installs", () => {
			expect(isSafeCommand("npm install lodash")).toBe(false);
			expect(isSafeCommand("yarn add react")).toBe(false);
			expect(isSafeCommand("pip install requests")).toBe(false);
			expect(isSafeCommand("brew install node")).toBe(false);
		});

		it("blocks redirects", () => {
			expect(isSafeCommand("echo hello > file.txt")).toBe(false);
			expect(isSafeCommand("cat foo >> bar")).toBe(false);
			expect(isSafeCommand(">file.txt")).toBe(false);
		});

		it("blocks dangerous commands", () => {
			expect(isSafeCommand("sudo rm -rf /")).toBe(false);
			expect(isSafeCommand("kill -9 1234")).toBe(false);
			expect(isSafeCommand("reboot")).toBe(false);
		});

		it("blocks editors", () => {
			expect(isSafeCommand("vim file.txt")).toBe(false);
			expect(isSafeCommand("nano file.txt")).toBe(false);
			expect(isSafeCommand("code .")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("requires command to be in safe list (not just non-destructive)", () => {
			expect(isSafeCommand("unknown-command")).toBe(false);
			expect(isSafeCommand("my-script.sh")).toBe(false);
		});

		it("handles commands with leading whitespace", () => {
			expect(isSafeCommand("  ls -la")).toBe(true);
			expect(isSafeCommand("  rm file")).toBe(false);
		});
	});
});

describe("cleanStepText", () => {
	it("removes markdown bold/italic", () => {
		expect(cleanStepText("**bold text**")).toBe("Bold text");
		expect(cleanStepText("*italic text*")).toBe("Italic text");
	});

	it("removes markdown code", () => {
		expect(cleanStepText("run `npm install`")).toBe("Npm install"); // "run" is stripped as action word
		expect(cleanStepText("check the `config.json` file")).toBe("Config.json file");
	});

	it("removes leading action words", () => {
		expect(cleanStepText("Create the new file")).toBe("New file");
		expect(cleanStepText("Run the tests")).toBe("Tests");
		expect(cleanStepText("Check the status")).toBe("Status");
	});

	it("capitalizes first letter", () => {
		expect(cleanStepText("update config")).toBe("Config");
	});

	it("keeps full text (truncation moved to the widget display)", () => {
		const longText = "This is a very long step description that exceeds the maximum allowed length for display";
		const result = cleanStepText(longText);
		assert.equal(result, longText);
	});

	it("normalizes whitespace", () => {
		expect(cleanStepText("multiple   spaces   here")).toBe("Multiple spaces here");
	});
});

describe("extractTodoItems", () => {
	it("extracts numbered items after Plan: header", () => {
		const message = `Here's what we'll do:

Plan:
1. First step here
2. Second step here
3. Third step here`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(3);
		expect(items[0].step).toBe(1);
		expect(items[0].text).toBe("First step here");
		expect(items[0].completed).toBe(false);
	});

	it("handles bold Plan header", () => {
		const message = `**Plan:**
1. Do something`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
	});

	it("handles parenthesis-style numbering", () => {
		const message = `Plan:
1) First item
2) Second item`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(2);
	});

	it("returns empty array without Plan header", () => {
		const message = `Here are some steps:
1. First step
2. Second step`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(0);
	});

	it("filters out short items", () => {
		const message = `Plan:
1. OK
2. This is a proper step`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
		expect(items[0].text).toContain("proper");
	});

	it("keeps steps that start with backticks (code-file steps)", () => {
		const message = `Plan:
1. \`npm install\`
2. Run the build process`;

		const items = extractTodoItems(message);
		assert.equal(items.length, 2);
		assert.equal(items[0].text, "Npm install");
	});

	it("extracts only the last Plan: section (thinking draft + text plan)", () => {
		const message = `Some reasoning...\nPlan:\n1. Draft one\n2. Draft two\nNow the answer.\nPlan:\n1. Print 1\n2. Print 2\n3. Print 3`;

		const items = extractTodoItems(message);
		assert.equal(items.length, 3);
		assert.deepEqual(
			items.map((i) => i.text),
			["Print 1", "Print 2", "Print 3"],
		);
	});

	it("extracts markdown step titles fully", () => {
		const message = `Plan:\n1. **Explore** the repo structure\n2. \`index.ts\` — fix getTextContent`;

		const items = extractTodoItems(message);
		assert.equal(items.length, 2);
		assert.equal(items[0].text, "Explore the repo structure");
		assert.equal(items[1].text, "Index.ts — fix getTextContent");
	});

	it("accepts a Plan: header followed by trailing whitespace", () => {
		const items = extractTodoItems("Plan:   \n1. Inspect the repository layout");
		assert.deepEqual(
			items.map((i) => i.text),
			["Inspect the repository layout"],
		);
	});

	it("ignores numbered text that does not start its line", () => {
		const message = `Plan:\n1. Inspect the repository layout\nUpgrade to v2. then run the checks`;
		assert.deepEqual(
			extractTodoItems(message).map((i) => i.text),
			["Inspect the repository layout"],
		);
	});

	it("accepts indented and multi-digit step numbers", () => {
		const message = `Plan:\n   1. Inspect the repository layout\n10) Inspect the build pipeline`;
		assert.deepEqual(
			extractTodoItems(message).map((i) => i.text),
			["Inspect the repository layout", "Inspect the build pipeline"],
		);
	});

	it("accepts a step whose text starts after blank lines", () => {
		const items = extractTodoItems("Plan:\n1.\n\nInspect the repository layout");
		assert.deepEqual(
			items.map((i) => i.text),
			["Inspect the repository layout"],
		);
	});

	it("skips steps of five characters or fewer and keeps six", () => {
		const message = `Plan:\n1. Do it\n2. Do it!\n3. Inspect it`;
		assert.deepEqual(
			extractTodoItems(message).map((i) => i.text),
			["Do it!", "Inspect it"],
		);
	});

	it("skips steps that start with a slash or dash but keeps ones that merely end with them", () => {
		const message = [
			"Plan:",
			"1. /usr/bin/tool is the target",
			"2. - nested bullet content",
			"3. Inspect the src/ folder/",
			"4. Inspect the build output -",
		].join("\n");
		assert.deepEqual(
			extractTodoItems(message).map((i) => i.text),
			["Inspect the src/ folder/", "Inspect the build output -"],
		);
	});
});

describe("extractDoneSteps", () => {
	it("extracts single DONE marker", () => {
		const message = "I've completed the first step [DONE:1]";
		expect(extractDoneSteps(message)).toEqual([1]);
	});

	it("extracts multiple DONE markers", () => {
		const message = "Did steps [DONE:1] and [DONE:2] and [DONE:3]";
		expect(extractDoneSteps(message)).toEqual([1, 2, 3]);
	});

	it("handles case insensitivity", () => {
		const message = "[done:1] [DONE:2] [Done:3]";
		expect(extractDoneSteps(message)).toEqual([1, 2, 3]);
	});

	it("extracts DONE marker variants", () => {
		const message = "[DONE:1] [DONE: 2] [DONE3] [Done:4] Done: 5";
		assert.deepEqual(extractDoneSteps(message), [1, 2, 3, 4, 5]);
	});

	it("extracts prose completion phrasings", () => {
		const message = "Step 6 done, Step 7 is complete, Step 8 finished";
		assert.deepEqual(extractDoneSteps(message), [6, 7, 8]);
	});

	it("does not match negated or unfinished phrasings", () => {
		const message = "Step 9 is not done, Step 10 incomplete";
		assert.deepEqual(extractDoneSteps(message), []);
	});

	it("extracts multi-digit step numbers from every marker style", () => {
		assert.deepEqual(extractDoneSteps("[DONE:12]"), [12]);
		assert.deepEqual(extractDoneSteps("[DONE 15]"), [15]);
		assert.deepEqual(extractDoneSteps("Done: 13"), [13]);
		assert.deepEqual(extractDoneSteps("Step 14 done"), [14]);
	});

	it("accepts whitespace variations inside markers", () => {
		assert.deepEqual(extractDoneSteps("Done:5"), [5]);
		assert.deepEqual(extractDoneSteps("Done : 6"), [6]);
		assert.deepEqual(extractDoneSteps("Step7 done"), [7]);
		assert.deepEqual(extractDoneSteps("Step 8  done"), [8]);
		assert.deepEqual(extractDoneSteps("Step 9 is  complete"), [9]);
	});

	it("does not match markers with extra letters before the separator", () => {
		assert.deepEqual(extractDoneSteps("[DONEfoo:5]"), []);
		assert.deepEqual(extractDoneSteps("Donexyz: 6"), []);
	});

	it("collapses duplicate markers", () => {
		assert.deepEqual(extractDoneSteps("[DONE:1] [DONE: 1]"), [1]);
	});

	it("ignores malformed markers", () => {
		const message = "[DONE:abc] [DONE:] [DONE:1]";
		expect(extractDoneSteps(message)).toEqual([1]);
	});
});

describe("markCompletedSteps", () => {
	it("marks matching items as completed", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First", completed: false },
			{ step: 2, text: "Second", completed: false },
			{ step: 3, text: "Third", completed: false },
		];

		const count = markCompletedSteps("[DONE:1] [DONE:3]", items);

		expect(count).toBe(2);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
		expect(items[2].completed).toBe(true);
	});

	it("returns count of completed items", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];

		expect(markCompletedSteps("[DONE:1]", items)).toBe(1);
		expect(markCompletedSteps("no markers", items)).toBe(0);
	});

	it("ignores markers for non-existent steps", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];

		const count = markCompletedSteps("[DONE:99]", items);

		assert.equal(count, 0); // Counts only newly marked items
		assert.equal(items[0].completed, false);
	});

	it("marks all remaining steps for whole-plan completion phrasings", () => {
		assert.equal(allStepsComplete("All steps complete, wrapping up"), true);
		assert.equal(allStepsComplete("Every step is finished"), true);
		assert.equal(allStepsComplete("The plan is done"), true);
		assert.equal(allStepsComplete("Step 1 complete, moving on"), false);
	});

	it("accepts affirmative completion but not negated, conditional, question, or partial words", () => {
		assert.equal(allStepsComplete("All steps are complete"), true);
		assert.equal(allStepsComplete("  ALL STEPS ARE COMPLETED!  "), true);
		for (const message of [
			"Not all steps complete",
			"If all steps complete, deploy",
			"Are all steps complete?",
			"All steps complete?",
			"All steps complete if tests pass",
			"The plan is done?",
			"The plan is done. Tests still fail.",
			"All steps completedness",
			"The plan is done if tests pass",
			"The plan is done, but tests still fail",
		]) {
			assert.equal(allStepsComplete(message), false, message);
		}
	});

	it("accepts the plan phrasing without a leading article or linking verb", () => {
		assert.equal(allStepsComplete("Plan is done"), true);
		assert.equal(allStepsComplete("The plan complete"), true);
		assert.equal(allStepsComplete("plan completed"), true);
	});

	it("accepts extra whitespace in whole-plan completion phrasings", () => {
		assert.equal(allStepsComplete("all  steps complete"), true);
		assert.equal(allStepsComplete("all steps  complete"), true);
		assert.equal(allStepsComplete("all steps is  done"), true);
		assert.equal(allStepsComplete("the plan  done"), true);
		assert.equal(allStepsComplete("the plan is  done"), true);
		assert.equal(allStepsComplete("the  plan is done"), true);
		assert.equal(allStepsComplete("all steps complete,wrapping up"), true);
	});

	it("does not treat words that merely end in the as an article before plan", () => {
		assert.equal(allStepsComplete("theoplan is done"), false);
	});

	it("doesn't double-complete already completed items", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: true }];

		markCompletedSteps("[DONE:1]", items);
		expect(items[0].completed).toBe(true);
	});
});
