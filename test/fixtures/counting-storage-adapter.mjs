// A storage adapter that only counts how often it is opened, into the file `options.log`: a check that must fail before
// any storage is touched proves it by leaving the count at zero.
import { appendFileSync } from "node:fs";

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options) {
		appendFileSync(String(options.log), "open\n");
		throw new Error("counting adapter: opened");
	},
};
