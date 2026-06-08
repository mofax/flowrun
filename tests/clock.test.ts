import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { type Clock, getClock, resetClock, setClock } from "../src/clock.ts";

// The default (production) Clock was never tested directly — FakeClock replaces
// it everywhere else. These tests cover its wall/monotonic readings, the
// `ms <= 0` fast path, the `setTimeout`-backed positive path, and the
// install/reset seam used by the rest of the system.

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	resetClock();
});

describe("DefaultClock", () => {
	test("now() reflects the wall clock (Date.now)", () => {
		resetClock();
		vi.spyOn(Date, "now").mockReturnValue(1_234_567);
		expect(getClock().now()).toBe(1_234_567);
	});

	test("monotonicNow() is non-negative and non-decreasing", () => {
		resetClock();
		const clock = getClock();
		const first = clock.monotonicNow();
		const second = clock.monotonicNow();
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThanOrEqual(first);
	});

	test("monotonicNow() is immune to wall-clock movement", () => {
		resetClock();
		const clock = getClock();
		const before = clock.monotonicNow();
		// Move the wall clock backwards (NTP step). Monotonic time must not regress.
		vi.spyOn(Date, "now").mockReturnValue(0);
		expect(clock.monotonicNow()).toBeGreaterThanOrEqual(before);
	});

	test("sleep(0) and sleep(negative) resolve without a timer", async () => {
		resetClock();
		vi.useFakeTimers();
		const clock = getClock();
		// These resolve purely on the microtask queue: awaiting them settles with no
		// fake timer ever being scheduled (asserted via getTimerCount below).
		await expect(clock.sleep(0)).resolves.toBeUndefined();
		await expect(clock.sleep(-5)).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("sleep(ms > 0) resolves only after the duration elapses", async () => {
		resetClock();
		vi.useFakeTimers();
		const clock = getClock();
		let resolved = false;
		void clock.sleep(50).then(() => {
			resolved = true;
		});

		await vi.advanceTimersByTimeAsync(49);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(true);
	});
});

describe("clock install seam", () => {
	test("setClock installs and getClock returns the installed clock", () => {
		const custom: Clock = {
			now: () => 42,
			monotonicNow: () => 7,
			sleep: () => Promise.resolve(),
		};
		setClock(custom);
		expect(getClock()).toBe(custom);
		expect(getClock().now()).toBe(42);
	});

	test("resetClock restores a default clock instance", () => {
		const custom: Clock = { now: () => 42, monotonicNow: () => 7, sleep: () => Promise.resolve() };
		setClock(custom);
		resetClock();
		expect(getClock()).not.toBe(custom);
	});
});
