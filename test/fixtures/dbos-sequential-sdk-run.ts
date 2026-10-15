import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";

const greet = workflow({
	name: "sequential-durable-greet",
	description: "One durable tool per standalone SDK run.",
	inputs: { name: Type.String() },
	outputs: { greeting: Type.String() },
	run: async (ctx) => ({
		greeting: await ctx.tool("greet", { name: ctx.inputs.name }, async () => `hello ${ctx.inputs.name}`),
	}),
});

for await (const line of createInterface({ input: process.stdin })) {
	const { id, command, sql: systemDatabaseUrl } = JSON.parse(line) as {
		id: number;
		command: string;
		sql: string;
	};
	try {
		if (command === "exit") {
			console.log(JSON.stringify({ id, result: {} }));
			process.exit(0);
		}
		assert.equal(command, "run");
		const results = [];
		for (const name of ["first", "second", "third"]) {
			const result = await run(greet, { name }, { durability: { mode: "durable", systemDatabaseUrl, poolSize: 2 } });
			results.push({ status: result.status, result: result.result, error: result.error });
		}
		console.log(JSON.stringify({ id, result: results }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: String(error) }));
	}
}
