import * as workflowsSdkSurface from "../../sdk-surface.js";
import { provideRunJournalHostModules } from "./resolution.js";

provideRunJournalHostModules({ "@bastani/atomic/workflows": workflowsSdkSurface });
