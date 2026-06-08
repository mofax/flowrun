import { resetClock } from "./clock.ts";
import { resetConfig } from "./config.ts";
import { resetSleepScheduler } from "./scheduler.ts";
import { resetStore } from "./store.ts";

/** Resets all module-level state. For use in tests only — not part of the public API. */
export function __resetForTests(): void {
	resetConfig();
	resetStore();
	resetClock();
	resetSleepScheduler();
}
