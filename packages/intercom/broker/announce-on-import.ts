import { announceBrokerStart } from "./start-announcement.js";

// Imported second by broker.ts, straight after the stderr cap and before any module that does real work, so the pid is
// announced before the broker's module graph loads: a crash while loading is then a crash the parent can see.
announceBrokerStart();
