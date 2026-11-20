// A custom worker entry that starts the sandbox's worker only when it is the thread's main module.
if (require.main === module) import("../../src/runtime/worker.ts");
