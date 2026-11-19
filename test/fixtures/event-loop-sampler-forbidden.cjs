const fs = require("node:fs");
const Module = require("node:module");

// Make the optional stack sampler unavailable, including in workers inheriting this preload.
const load = Module._load;
Module._load = function (specifier, parent, isMain) {
	if (specifier === "inspector" || specifier.startsWith("node:inspector") || specifier.startsWith("inspector/")) {
		fs.appendFileSync(process.env.ATOMIC_TEST_INSPECTOR_IMPORTS, `${specifier}\n`);
		throw new Error("the optional inspector sampler must stay unloaded without its diagnostic flag");
	}
	return load.call(this, specifier, parent, isMain);
};
