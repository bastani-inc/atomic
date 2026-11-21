/** Exit status of the compile-cache helper: the cache is warm for its build, runtime and flags (now or already). */
export const COMPILE_CACHE_WARMUP_DONE = 0;
/** Exit status of the compile-cache helper: another helper is warming the same build. */
export const COMPILE_CACHE_WARMUP_BUSY = 3;

/**
 * libuv's flag for opening a file in exclusive sharing mode on Windows: no other open of it succeeds until the handle
 * closes, which the system does when its process ends however it ends. Node passes open flags through to libuv.
 */
export const WINDOWS_EXCLUSIVE_OPEN_FLAG = 0x10000000;
