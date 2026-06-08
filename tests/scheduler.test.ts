import { afterEach, describe, expect, test } from "vite-plus/test";

import { resetClock, setClock } from "../src/clock.ts";
import { getSleepScheduler, resetSleepScheduler, SleepScheduler } from "../src/scheduler.ts";
import { FakeClock } from "./helpers.ts";

// The shared min-heap scheduler is the most algorithmically involved code in the
// package, yet was previously exercised only indirectly, and only ever with a
// single in-flight timer — bubbleDown/popMin and the driver re-arm logic had no
// coverage at all. These tests drive the heap directly against a FakeClock and
// assert (a) ascending fire order, (b) that a later-armed driver is *preempted*
// by a sooner deadline, (c) duplicate deadlines, and (d) past deadlines.

function fresh(): { clock: FakeClock; scheduler: SleepScheduler } {
	resetSleepScheduler();
	const clock = new FakeClock();
	setClock(clock);
	return { clock, scheduler: getSleepScheduler() };
}

afterEach(() => {
	resetSleepScheduler();
	resetClock();
});

describe("SleepScheduler", () => {
	test("resolves a single timer once its deadline elapses, not before", async () => {
		const { clock, scheduler } = fresh();
		let fired = false;
		void scheduler.schedule(100).then(() => {
			fired = true;
		});

		await clock.advanceAsync(99);
		expect(fired).toBe(false);

		await clock.advanceAsync(1);
		expect(fired).toBe(true);
	});

	test("fires timers in ascending wakeAt order regardless of insertion order", async () => {
		const { clock, scheduler } = fresh();
		const fired: number[] = [];

		// Inserted out of order; exercises bubbleUp on insert and bubbleDown on pop.
		const p30 = scheduler.schedule(30).then(() => fired.push(30));
		const p10 = scheduler.schedule(10).then(() => fired.push(10));
		const p20 = scheduler.schedule(20).then(() => fired.push(20));

		await clock.advanceAsync(10);
		await p10;
		expect(fired).toEqual([10]);

		await clock.advanceAsync(10);
		await p20;
		expect(fired).toEqual([10, 20]);

		await clock.advanceAsync(10);
		await p30;
		expect(fired).toEqual([10, 20, 30]);
	});

	test("preempts a later-armed driver when a sooner deadline is scheduled", async () => {
		const { clock, scheduler } = fresh();
		const fired: number[] = [];

		// Arm the driver for a distant deadline first...
		void scheduler.schedule(1000).then(() => fired.push(1000));
		// ...then add a much sooner one. The earlier prior implementation would have
		// made this fire late (at t=1000); a correct scheduler fires it at t=10.
		const near = scheduler.schedule(10).then(() => fired.push(10));

		await clock.advanceAsync(10);
		await near;
		expect(fired).toEqual([10]);
	});

	test("fires multiple due timers in one driver wake (single big jump)", async () => {
		const { clock, scheduler } = fresh();
		const fired: number[] = [];
		const deadlines = [50, 10, 40, 20, 30];
		const promises = deadlines.map((d) => scheduler.schedule(d).then(() => fired.push(d)));

		await clock.advanceAsync(50);
		await Promise.all(promises);

		expect(fired).toEqual([10, 20, 30, 40, 50]);
	});

	test("fires duplicate deadlines independently", async () => {
		const { clock, scheduler } = fresh();
		let count = 0;
		const a = scheduler.schedule(25).then(() => count++);
		const b = scheduler.schedule(25).then(() => count++);

		await clock.advanceAsync(25);
		await Promise.all([a, b]);
		expect(count).toBe(2);
	});

	test("fires immediately for a deadline already in the past", async () => {
		const { clock, scheduler } = fresh();
		clock.advance(100); // now = 100
		let fired = false;
		const p = scheduler.schedule(50).then(() => {
			fired = true;
		});

		// delay clamps to 0; resolution happens on the next microtask turn.
		await clock.advanceAsync(0);
		await p;
		expect(fired).toBe(true);
	});

	test("re-arms for newly scheduled work after the heap drains", async () => {
		const { clock, scheduler } = fresh();
		const fired: number[] = [];

		const first = scheduler.schedule(10).then(() => fired.push(10));
		await clock.advanceAsync(10);
		await first;
		expect(fired).toEqual([10]);

		// Heap is empty and the driver has stood down; a new schedule must re-arm.
		const second = scheduler.schedule(10).then(() => fired.push(20));
		await clock.advanceAsync(10);
		await second;
		expect(fired).toEqual([10, 20]);
	});

	test("maintains heap order under a randomized workload", async () => {
		const { clock, scheduler } = fresh();
		const fired: number[] = [];
		const deadlines = Array.from({ length: 64 }, () => Math.floor(Math.random() * 500) + 1);
		const promises = deadlines.map((d) => scheduler.schedule(d).then(() => fired.push(d)));

		await clock.advanceAsync(Math.max(...deadlines));
		await Promise.all(promises);

		expect(fired).toEqual([...deadlines].sort((a, b) => a - b));
	});
});

describe("getSleepScheduler / resetSleepScheduler", () => {
	test("getSleepScheduler returns a stable singleton", () => {
		resetSleepScheduler();
		expect(getSleepScheduler()).toBe(getSleepScheduler());
	});

	test("resetSleepScheduler yields a fresh instance", () => {
		const a = getSleepScheduler();
		resetSleepScheduler();
		expect(getSleepScheduler()).not.toBe(a);
	});
});
