import { closeSync, openSync, writeSync } from "node:fs";

const countFd = process.env.ATOMIC_TEST_CLEAN_COUNT ? openSync(process.env.ATOMIC_TEST_CLEAN_COUNT, "a") : undefined;
const FLUSH = Symbol("flush");
let buffered = Buffer.alloc(0);
const waiting = [];

process.stdin.on("data", (chunk) => {
	buffered = Buffer.concat([buffered, chunk]);
	drain();
});
process.stdin.on("end", () => {
	if (countFd !== undefined) closeSync(countFd);
	process.exit(0);
});

function drain() {
	while (waiting.length > 0 && buffered.length >= 4) {
		const length = Number.parseInt(buffered.subarray(0, 4).toString("ascii"), 16);
		if (length === 0) {
			buffered = buffered.subarray(4);
			waiting.shift()(FLUSH);
			continue;
		}
		if (buffered.length < length) return;
		const payload = buffered.subarray(4, length);
		buffered = buffered.subarray(length);
		waiting.shift()(payload);
	}
}

const readPacket = () =>
	new Promise((resolve) => {
		waiting.push(resolve);
		drain();
	});

async function readList() {
	const lines = [];
	for (let packet = await readPacket(); packet !== FLUSH; packet = await readPacket()) {
		lines.push(packet.toString("utf8").replace(/\n$/, ""));
	}
	return lines;
}

async function readContent() {
	const parts = [];
	for (let packet = await readPacket(); packet !== FLUSH; packet = await readPacket()) parts.push(packet);
	return Buffer.concat(parts);
}

const MAX_PAYLOAD = 65516;
const packet = (payload) => {
	const body = typeof payload === "string" ? Buffer.from(payload) : payload;
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};
const flush = () => Buffer.from("0000");

function writeList(lines) {
	process.stdout.write(Buffer.concat([...lines.map((line) => packet(`${line}\n`)), flush()]));
}

function writeContent(content) {
	const parts = [];
	for (let offset = 0; offset < content.length; offset += MAX_PAYLOAD) {
		parts.push(packet(content.subarray(offset, offset + MAX_PAYLOAD)));
	}
	process.stdout.write(Buffer.concat([...parts, flush()]));
}

await readList();
writeList(["git-filter-server", "version=2"]);
await readList();
writeList(["capability=clean"]);
for (;;) {
	const request = await readList();
	const content = await readContent();
	if (request.includes("command=clean") && countFd !== undefined) writeSync(countFd, "clean\n");
	writeList(["status=success"]);
	writeContent(content);
	writeList([]);
}
