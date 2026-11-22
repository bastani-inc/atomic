import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../packages/coding-agent/dist/index.js";

const [root, ...args] = process.argv.slice(2);
const outbox = [];
const flushed = Promise.withResolvers();
const listener = (atomic) => {
	atomic.on("session_start", () => { outbox.push("accepted before quit"); });
	atomic.on("session_shutdown", async ({ reason }) => {
		if (reason !== "quit") return;
		writeFileSync(join(root, "quitting"), "");
		let timer;
		try {
			await Promise.race([
				flushed.promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("unflushed record")), 5_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	});
};
const exporter = {
	name: "outbox",
	builtin: true,
	factory() {
		writeFileSync(join(root, "exported"), outbox.join("\n"));
		flushed.resolve();
	},
};
await main(args, { extensionFactories: [listener, exporter] });
