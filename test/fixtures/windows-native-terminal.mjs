const watchdog = setTimeout(() => process.exit(91), 12000);
process.stdin.setRawMode(true);
process.stdin.resume();
// Node reads the console's size again only when libuv reports a resize, which on Windows it does from its own watcher
// thread some time after the pseudo console resized. Report the size each time Node has it.
process.stdout.on("resize", () => process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`));
process.stdout.write(`READY:${process.stdin.isTTY}:${process.stdout.isTTY}:${process.stdout.columns}x${process.stdout.rows}\r\n`);
process.stdin.on("data", (bytes) => {
	const text = bytes.toString("utf8");
	if (text.includes("hello")) process.stdout.write("INPUT:hello\r\n");
	if (text.includes("done")) {
		process.stdout.write("TERMINAL_DONE\r\n", () => {
			clearTimeout(watchdog);
			process.exit(7);
		});
	}
});
