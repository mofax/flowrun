import { setClock, type Clock } from "../src/clock.ts";
import flowrun from "../src/index.ts";
import { __resetForTests } from "../src/testing.ts";

/**
 * Deterministic virtual {@link Clock} for tests.
 *
 * Design note — wall vs. monotonic time are modelled *independently*.
 * `clock.ts` deliberately distinguishes {@link Clock.now} (wall-clock, used for
 * durable `wakeAt` timestamps) from {@link Clock.monotonicNow} (monotonic, used
 * for relative waits that must be immune to wall-clock skew). A fake that keeps
 * the two in lockstep cannot exercise that distinction — a regression that made
 * a relative wait depend on the wall clock would pass undetected. We therefore
 * keep two separate counters:
 *
 *   - {@link advance} advances *both* in lockstep (ordinary virtual time) and is
 *     what the vast majority of tests want.
 *   - {@link advanceMono} / {@link advanceWall} move them independently so a test
 *     can inject wall-clock skew (NTP step, suspend/resume) and assert which
 *     subsystem is affected.
 *
 * Timers registered through {@link sleep} fire on the *monotonic* axis, mirroring
 * `setTimeout`, whose firing is duration-based rather than wall-clock-based.
 */
export class FakeClock implements Clock {
	private wallTime: number;
	private monoTime = 0;
	private readonly timers: Array<{ at: number; resolve: () => void }> = [];

	constructor(options?: { wallStart?: number }) {
		this.wallTime = options?.wallStart ?? 0;
	}

	now(): number {
		return this.wallTime;
	}

	monotonicNow(): number {
		return this.monoTime;
	}

	sleep(ms: number): Promise<void> {
		if (ms <= 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.timers.push({ at: this.monoTime + ms, resolve });
		});
	}

	/** Advance wall and monotonic clocks together by `ms` (ordinary virtual time). */
	advance(ms: number): void {
		this.wallTime += ms;
		this.monoTime += ms;
		this.drainTimers();
	}

	/**
	 * Advance virtual time and yield around it so suspended `await sleep(...)`
	 * continuations and the scheduler's driver microtasks get a chance to run.
	 */
	async advanceAsync(ms: number): Promise<void> {
		await Promise.resolve();
		this.advance(ms);
		await Promise.resolve();
	}

	/** Advance only the monotonic axis (fires duration-based timers). */
	advanceMono(ms: number): void {
		this.monoTime += ms;
		this.drainTimers();
	}

	/**
	 * Step the wall clock by `ms` (may be negative) without touching monotonic
	 * time. Models wall-clock skew; does not by itself fire `sleep` timers.
	 */
	advanceWall(ms: number): void {
		this.wallTime += ms;
	}

	private drainTimers(): void {
		this.timers.sort((a, b) => a.at - b.at);
		while (this.timers.length > 0 && this.timers[0]!.at <= this.monoTime) {
			const timer = this.timers.shift()!;
			timer.resolve();
		}
	}
}

/** Reset all module-global singletons and install a fresh {@link FakeClock}. */
export function setupTest(options?: { wallStart?: number }): FakeClock {
	__resetForTests();
	const clock = new FakeClock(options);
	setClock(clock);
	return clock;
}

/**
 * Resolve all currently-queued microtasks by bouncing off a *macrotask*.
 *
 * Useful when a test needs every pending `await` continuation to settle (e.g.
 * to observe that an engine suspended on a backoff `sleep` before any virtual
 * time has been advanced). Uses a real `setTimeout`, so do not call it while
 * fake timers are installed.
 */
export function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export { flowrun };
