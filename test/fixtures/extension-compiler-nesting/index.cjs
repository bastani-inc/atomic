const { join } = require("node:path");
const { createJiti } = require("jiti");

module.exports = (strict) => {
	const plugin = () => ({
		post(file) {
			const target = () => file.path.get("body.0.expression.right");
			target().setData("replacement", 42);
			// Loading the helper compiles it while this extension's own compiler is still running.
			require("./macro.cjs").emit(target(), strict);
		},
	});
	const compiler = createJiti(__filename, {
		fsCache: false,
		moduleCache: false,
		transformOptions: { babel: { plugins: [plugin] } },
	});
	return compiler.evalModule("module.exports = 1;", { filename: join(__dirname, "snippet.ts"), forceTranspile: true });
};
