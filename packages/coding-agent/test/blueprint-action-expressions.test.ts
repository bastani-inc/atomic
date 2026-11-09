import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	closedObject,
	type ExpressionContext,
	ExpressionError,
	type ExpressionValue,
	evaluateCondition,
	evaluateExpression,
	interpolate,
	toText,
} from "../src/core/resume/blueprint/action-expressions.ts";

const context: ExpressionContext = {
	failed: false,
	roots: {
		inputs: { name: "World", empty: "", count: "3", zero: 0, nan: Number.NaN },
		env: { FOO: "bar" },
		github: closedObject("github", { repository: "atomic/blueprint", event: {} }),
		steps: { build: closedObject("steps.build", { outputs: { path: "/dist" } }) },
	},
};
const failedContext: ExpressionContext = { ...context, failed: true };

function problemOf(source: string): string {
	try {
		evaluateExpression(source, context);
	} catch (error) {
		assert.ok(error instanceof ExpressionError, `expected an ExpressionError for ${source}, got ${String(error)}`);
		return error.problem;
	}
	assert.fail(`${source} should not evaluate`);
}

function problemOfTemplate(template: string): string {
	try {
		interpolate(template, context);
	} catch (error) {
		assert.ok(error instanceof ExpressionError, `expected an ExpressionError for ${template}, got ${String(error)}`);
		return error.problem;
	}
	assert.fail(`${template} should not interpolate`);
}

function expression(source: string): string {
	return `$\{{ ${source} }}`;
}

describe("ExpressionError", () => {
	test("names the problem and the first 80 characters of the trimmed source (#4588)", () => {
		const error = new ExpressionError("  inputs.name  ", "something is wrong");

		assert.equal(error.name, "ExpressionError");
		assert.equal(error.problem, "something is wrong");
		assert.equal(error.message, 'something is wrong in "inputs.name"');
		assert.equal(new ExpressionError("a".repeat(100), "long").message, `long in "${"a".repeat(80)}"`);
	});
});

describe("evaluating expressions", () => {
	test("compares values the way GitHub does (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["1 == 1", true],
			["1 == 2", false],
			["true == true", true],
			["true == false", false],
			["null == null", true],
			["'a' == 'A'", true],
			["'a' == 'b'", false],
			["'1' == 1", true],
			["1 == '1'", true],
			["1 == '2'", false],
			["1 == 'abc'", false],
			["'a' == null", false],
			["'' == null", true],
			["'  ' == 0", true],
			["null == 0", true],
			["null == false", true],
			["false == 0", true],
			["false == '0'", true],
			["true == 1", true],
			["true == 2", false],
			["inputs == inputs", true],
			["github.event == github.event", true],
			["github.event == 1", false],
			["github.event == 'Object'", false],
			["1 == github.event", false],
			["fromJSON('[]') == 1", false],
			["fromJSON('[]') == fromJSON('[]')", false],
			["fromJSON('[]') == github.event", false],
			["1 != 2", true],
			["1 != 1", false],
			["'a' != 'A'", false],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("chains equality operators from the left and ranks && above || (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["1 == 1 == true", true],
			["1 == 2 == false", true],
			["1 == 1 != true", false],
			["1 != 2 == true", true],
			["1 != 2 != true", false],
			["true || false && false", true],
			["false && false || true", true],
			["!false == true", true],
			["true && true && 'last'", "last"],
			["false || false || 'last'", "last"],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("short-circuits && and || and yields the deciding operand (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["null && 'x'", null],
			["inputs.missing && 'x'", null],
			["0 && 'x'", 0],
			["'' && 'x'", ""],
			["inputs.nan && 'x'", Number.NaN],
			["false && 'x'", false],
			["'a' && 'b'", "b"],
			["1 && 0", 0],
			["null || 'b'", "b"],
			["0 || 'b'", "b"],
			["inputs.zero || 'b'", "b"],
			["'' || 'b'", "b"],
			["inputs.nan || 'b'", "b"],
			["false || 'b'", "b"],
			["'a' || 'b'", "a"],
			["1 || 2", 1],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("negates by truthiness (#4588)", () => {
		const falsy = ["null", "0", "''", "false", "inputs.missing", "inputs.zero", "inputs.nan", "inputs.empty"];
		const truthy = ["1", "'x'", "true", "-1", "inputs.name", "fromJSON('[]')", "github.event"];
		for (const source of falsy) assert.equal(evaluateExpression(`!${source}`, context), true, `!${source}`);
		for (const source of truthy) assert.equal(evaluateExpression(`!${source}`, context), false, `!${source}`);
		assert.equal(evaluateExpression("!!inputs.name", context), true);
	});

	test("reads properties and indexes case-insensitively, preferring an exact key (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["INPUTS.NAME", "World"],
			["inputs['NAME']", "World"],
			["inputs.missing", null],
			["inputs.name.length", null],
			["inputs[1]", null],
			["inputs[true]", null],
			["inputs[inputs.name]", null],
			["github.event.number", null],
			["steps.absent.outputs.path", null],
			['fromJSON(\'["a","b"]\')[1]', "b"],
			['fromJSON(\'["a","b"]\')[5]', null],
			["fromJSON('[\"a\"]')['0']", null],
			["fromJSON('[0]')[0]", 0],
			['fromJSON(\'{"a":1,"A":2}\').A', 2],
			['fromJSON(\'{"a":1,"A":2}\').a', 1],
			["fromJSON('{\"a\":1,\"A\":2}')['A']", 2],
			['fromJSON(\'{"a": {"b": 3}}\').a.b', 3],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("reads literals of every kind (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["TRUE", true],
			["False", false],
			["NULL", null],
			["0x10", 16],
			["1.5", 1.5],
			["1e3", 1000],
			["-3", -3],
			["'it''s'", "it's"],
			["  'padded'  ", "padded"],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("calls the functions GitHub defines (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["contains('Hello World', 'WORLD')", true],
			["contains('Hello', 'xyz')", false],
			["contains(12345, 34)", true],
			["contains(fromJSON('[1,\"B\"]'), 'b')", true],
			["contains(fromJSON('[1]'), 2)", false],
			["contains(fromJSON('[1]'), '1')", true],
			["startsWith(inputs.name, 'wor')", true],
			["startsWith('abc', 'bc')", false],
			["endsWith(inputs.name, 'LD')", true],
			["endsWith('abc', 'ab')", false],
			["format('{0}-{1} {{x}}', 'a', 1)", "a-1 {x}"],
			["format('{1}{0}{1}', 'a', 'b')", "bab"],
			["format('plain')", "plain"],
			["format('{10}', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'ten')", "ten"],
			["format('{0}|{1}|{2}|{3}|{4}', null, true, 1.5, fromJSON('[1]'), fromJSON('{}'))", "|true|1.5|Array|Object"],
			["join(fromJSON('[\"a\", \"b\"]'), '+')", "a+b"],
			['join(fromJSON(\'["a", "b"]\'))', "a,b"],
			["join(fromJSON('[1,true,null]'), '-')", "1-true-"],
			["join(fromJSON('[1,2]'), 0)", "102"],
			["join('solo')", "solo"],
			["join(5, '-')", "5"],
			["toJSON(fromJSON('[1]'))", "[\n  1\n]"],
			["toJSON(fromJSON('{\"a\":[1]}'))", '{\n  "a": [\n    1\n  ]\n}'],
			["toJSON('x')", '"x"'],
			['fromJSON(\'{"a": {"b": 3}}\').a.b', 3],
			["fromJSON('null')", null],
			["fromJSON(3)", 3],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("answers the status functions from whether an earlier step failed (#4588)", () => {
		const expected: ReadonlyArray<readonly [string, boolean, boolean]> = [
			["success()", true, false],
			["failure()", false, true],
			["always()", true, true],
			["cancelled()", false, false],
		];
		for (const [source, whenPassing, whenFailed] of expected) {
			assert.equal(evaluateExpression(source, context), whenPassing, `${source} after a pass`);
			assert.equal(evaluateExpression(source, failedContext), whenFailed, `${source} after a failure`);
		}
	});

	test("names the problem of what it cannot evaluate (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["1 < 2", 'unsupported syntax near "< 2"'],
			["inputs.name = 'World'", `unsupported syntax near "= 'World'"`],
			["inputs.name @@@@@@@@@@@@@@@@@@", 'unsupported syntax near "@@@@@@@@@@@@"'],
			["'unterminated string", `unsupported syntax near "'unterminate"`],
			["", "expected a value"],
			["inputs.name ||", "expected a value"],
			[")", 'unexpected ")"'],
			[",", 'unexpected ","'],
			["(1", 'expected ")"'],
			["inputs[1", 'expected "]"'],
			["contains('a', 'b'", 'expected ")"'],
			["inputs.", 'expected a property name after "."'],
			["inputs.1", 'expected a property name after "."'],
			["inputs.name inputs.name", "unexpected input after the expression"],
			["inputs.name)", "unexpected input after the expression"],
			["hashFiles('**/package.json')", "unsupported function hashFiles"],
			["toString(1)", "unsupported function toString"],
			["contains('a')", "contains was given 1 arguments"],
			["contains('a', 'b', 'c')", "contains was given 3 arguments"],
			["format()", "format was given 0 arguments"],
			["join('a', 'b', 'c')", "join was given 3 arguments"],
			["always(1)", "always was given 1 arguments"],
			["success('x', 'y')", "success was given 2 arguments"],
			["secrets.TOKEN", "unsupported context secrets"],
			["matrix.os", "unsupported context matrix"],
			["github.nothing", "unsupported property github.nothing"],
			["steps.build.outcome", "unsupported property steps.build.outcome"],
			["github['nothing']", "unsupported property github.nothing"],
			["fromJSON('{')", "fromJSON was given text that is not JSON"],
			["format('{1}', 'a')", "format was given a placeholder it cannot fill"],
			["format('{0', 'a')", "format was given a placeholder it cannot fill"],
			["format('{0x', 'a')", "format was given a placeholder it cannot fill"],
			["format('{}', 'a')", "format was given a placeholder it cannot fill"],
			["format('{x1}', 'a', 'b')", "format was given a placeholder it cannot fill"],
			["format('{1x}', 'a', 'b')", "format was given a placeholder it cannot fill"],
			["format('{-1}', 'a')", "format was given a placeholder it cannot fill"],
			["format('a}')", "format was given an unmatched }"],
			["format('}x')", "format was given an unmatched }"],
		];
		for (const [source, problem] of cases) {
			assert.equal(problemOf(source), problem, source);
		}
	});

	test("puts the whole expression in the message of the error (#4588)", () => {
		assert.throws(
			() => evaluateExpression("  secrets.TOKEN  ", context),
			(error: Error) =>
				error instanceof ExpressionError && error.message === 'unsupported context secrets in "secrets.TOKEN"',
		);
	});
});

describe("converting values to text", () => {
	test("renders null as empty, objects and arrays by their kind and the rest as JavaScript does (#4588)", () => {
		assert.equal(toText(null), "");
		assert.equal(toText(undefined), "");
		assert.equal(toText([1, 2]), "Array");
		assert.equal(toText([]), "Array");
		assert.equal(toText({ a: 1 }), "Object");
		assert.equal(toText({}), "Object");
		assert.equal(toText(true), "true");
		assert.equal(toText(false), "false");
		assert.equal(toText(0), "0");
		assert.equal(toText(1.5), "1.5");
		assert.equal(toText("text"), "text");
		assert.equal(toText(""), "");
	});
});

describe("interpolating templates", () => {
	test("replaces each expression segment with the text of its value (#4588)", () => {
		assert.equal(interpolate(`hi ${expression("inputs.name")}!`, context), "hi World!");
		assert.equal(interpolate(`a${expression("inputs.name")}b${expression("inputs.count")}c`, context), "aWorldb3c");
		assert.equal(interpolate(`[${expression("inputs.missing")}]`, context), "[]");
		assert.equal(interpolate(`[${expression("github.event")}]`, context), "[Object]");
		assert.equal(interpolate(`[${expression("fromJSON('[1]')")}]`, context), "[Array]");
		assert.equal(interpolate(`${expression("'}}'")}${expression("inputs.count")}`, context), "}}3");
		assert.equal(interpolate("no expression", context), "no expression");
		assert.equal(interpolate("", context), "");
	});

	test("does not end an expression at a single } (#4588)", () => {
		assert.equal(problemOfTemplate(`$\{{ inputs.name } }}`), 'unsupported syntax near "} "');
	});

	test("reports an unterminated expression with the text from its start (#4588)", () => {
		assert.throws(
			() => interpolate("prefix ${{ inputs.name", context),
			(error: Error) =>
				error instanceof ExpressionError &&
				error.problem === 'unterminated "${{"' &&
				error.message === 'unterminated "${{" in "${{ inputs.name"',
		);
		assert.throws(() => interpolate(`$\{{ 'a}} }}`, context), ExpressionError);
	});

	test("passes the problem of an expression it cannot evaluate through (#4588)", () => {
		assert.equal(problemOfTemplate(expression("secrets.TOKEN")), "unsupported context secrets");
	});
});

describe("evaluating conditions", () => {
	test("accepts a condition with or without its braces and surrounding whitespace (#4588)", () => {
		assert.equal(evaluateCondition("inputs.name == 'World'", context), true);
		assert.equal(evaluateCondition(expression("inputs.name == 'World'"), context), true);
		assert.equal(evaluateCondition(`  ${expression("inputs.name == 'World'")}  `, context), true);
		assert.equal(evaluateCondition("  inputs.name == 'other'  ", context), false);
		assert.equal(evaluateCondition(expression("inputs.empty"), context), false);
		assert.equal(evaluateCondition(expression("'a' == 'b'"), context), false);
	});

	test("does not unwrap what merely ends in }} or only starts with ${{ (#4588)", () => {
		assert.throws(
			() => evaluateCondition("abctrue}}", context),
			(error: Error) =>
				error instanceof ExpressionError && error.message === 'unsupported syntax near "}}" in "abctrue}}"',
		);
		assert.throws(
			() => evaluateCondition(`${expression("inputs.name")} == 'World'`, context),
			(error: Error) =>
				error instanceof ExpressionError && error.problem === 'unsupported syntax near "${{ inputs.n"',
		);
		assert.throws(
			() => evaluateCondition(`${expression("inputs.name")}${expression("inputs.count")}`, context),
			(error: Error) => error instanceof ExpressionError && error.problem.startsWith("unsupported syntax near"),
		);
	});

	test("requires that no earlier step failed unless the condition uses a status function (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, boolean, boolean]> = [
			["inputs.name == 'World'", true, false],
			["!inputs.empty", true, false],
			["fromJSON('[\"x\"]')[0]", true, false],
			["contains('a', 'a')", true, false],
			["success()", true, false],
			["!success()", false, true],
			["failure()", false, true],
			["!failure()", true, false],
			["always()", true, true],
			["cancelled()", false, false],
			["!cancelled()", true, true],
			["failure() == true", false, true],
			["true == failure()", false, true],
			["inputs.name == 'World' && failure()", false, true],
			["inputs.name == 'other' || failure()", false, true],
			["startsWith(format('{0}', failure()), 't')", false, true],
			["contains('xtruex', format('{0}', failure()))", false, true],
			["fromJSON('[\"x\"]')[failure() && 0]", false, true],
			["(failure() && fromJSON('[\"x\"]'))[0]", false, true],
			["(failure() && inputs).name", false, true],
			["(success() && inputs).name", true, false],
		];
		for (const [condition, whenPassing, whenFailed] of cases) {
			assert.equal(evaluateCondition(condition, context), whenPassing, `${condition} after a pass`);
			assert.equal(evaluateCondition(condition, failedContext), whenFailed, `${condition} after a failure`);
		}
	});
});

describe("fromJSON failures (#4588)", () => {
	test("text that is not JSON is an expression error that keeps the parse error as its cause (#4588)", () => {
		assert.throws(
			() => evaluateExpression("fromJSON('{')", context),
			(error: unknown) => {
				assert.ok(error instanceof ExpressionError);
				assert.equal(error.problem, "fromJSON was given text that is not JSON");
				assert.ok(error.cause instanceof SyntaxError);
				return true;
			},
		);
	});
});
