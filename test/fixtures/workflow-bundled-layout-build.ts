import process from "node:process";

const HOST_PROVIDED_EXTERNALS = [
	"@bastani/atomic",
	"@bastani/atomic/*",
	"@bastani/atomic-natives",
	"@bastani/pi-ai",
	"@bastani/pi-ai/compat",
	"@bastani/pi-ai/oauth",
	"@bastani/pi-ai/api/cloudflare-gateway-binding",
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/typebox",
	"@sinclair/typebox/*",
	"proper-lockfile",
];

const [entry = "", outfile = ""] = process.argv.slice(2);
const result = await Bun.build({
	entrypoints: [entry],
	target: "node",
	format: "esm",
	external: HOST_PROVIDED_EXTERNALS,
	define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
});
const output = result.outputs[0];
if (!result.success || output === undefined) {
	throw new Error(`bundle failed: ${result.logs.map((log) => log.message).join("\n")}`);
}
await Bun.write(outfile, await output.text());
