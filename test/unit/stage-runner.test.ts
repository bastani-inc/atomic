/**
 * Unit tests for createStageContext split into feature modules.
 *
 * This entrypoint preserves the original module execution order for shared
 * stage-runner behavior while keeping each sibling test file under the file
 * length limit.
 */

import "./stage-runner-prompt-metadata.test.js";
import "./stage-runner-complete-metadata.test.js";
import "./stage-runner-errors.test.js";
import "./stage-runner-session-directories.test.js";
import "./stage-runner-structured-output.test.js";
import "./stage-runner-model-fallback-1.test.js";
import "./stage-runner-model-fallback-2.test.js";
import "./stage-runner-lazy-attach.test.js";
import "./stage-runner-controlled-pause.test.js";
import "./stage-runner-reasoning-suffix.test.js";
