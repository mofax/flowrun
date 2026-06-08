import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
	defaultBackoff,
	exponentialBackoff,
	exponentialFullJitterBackoff,
	fixedBackoff,
	linearBackoff,
} from "../src/backoff.ts";

// The backoff strategies are pure functions of the (1-indexed) attempt number.
// They are the policy that governs every retry in the engine — including the
// default applied when a caller supplies no `backoff` — yet were previously
// only ever used as a `{ delay: 0 }` test helper, with their output never
// asserted. These tests pin the closed-form b(i) for each strategy, the
// documented defaults, and the cap/jitter boundaries.

const DEFAULT_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;

describe("fixedBackoff — b(i) = d", () => {
	test("is constant across attempts", () => {
		const b = fixedBackoff({ delay: 250 });
		expect([1, 2, 3, 10, 100].map(b)).toEqual([250, 250, 250, 250, 250]);
	});

	test("defaults to 1000ms", () => {
		expect(fixedBackoff()(1)).toBe(DEFAULT_DELAY);
	});

	test("honours an explicit zero delay", () => {
		expect(fixedBackoff({ delay: 0 })(5)).toBe(0);
	});
});

describe("linearBackoff — b(i) = d * i", () => {
	test("scales linearly with the attempt number", () => {
		const b = linearBackoff({ delay: 100 });
		expect([1, 2, 3, 4].map(b)).toEqual([100, 200, 300, 400]);
	});

	test("defaults to a 1000ms base", () => {
		expect(linearBackoff()(3)).toBe(3 * DEFAULT_DELAY);
	});
});

describe("exponentialBackoff — b(i) = min(d_max, d * 2^(i-1))", () => {
	test("doubles each attempt below the cap", () => {
		const b = exponentialBackoff({ delay: 1000, maxDelay: 1_000_000 });
		expect([1, 2, 3, 4, 5].map(b)).toEqual([1000, 2000, 4000, 8000, 16000]);
	});

	test("saturates at maxDelay", () => {
		const b = exponentialBackoff({ delay: 1000, maxDelay: 30_000 });
		// 1000 * 2^4 = 16000 < 30000; 1000 * 2^5 = 32000 -> capped to 30000.
		expect(b(5)).toBe(16_000);
		expect(b(6)).toBe(DEFAULT_MAX_DELAY);
		expect(b(7)).toBe(DEFAULT_MAX_DELAY);
		expect(b(50)).toBe(DEFAULT_MAX_DELAY);
	});

	test("first attempt equals the base delay (2^0 = 1)", () => {
		expect(exponentialBackoff({ delay: 1000 })(1)).toBe(1000);
	});

	test("applies documented defaults (d=1000, d_max=30000)", () => {
		const b = exponentialBackoff();
		expect(b(1)).toBe(DEFAULT_DELAY);
		expect(b(100)).toBe(DEFAULT_MAX_DELAY);
	});
});

describe("exponentialFullJitterBackoff — Uniform(0, cap)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns floor(random * cap) where cap is the exponential value", () => {
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const b = exponentialFullJitterBackoff({ delay: 1000, maxDelay: 1_000_000 });

		// cap(i) = 1000 * 2^(i-1); result = floor(0.5 * cap).
		expect(b(1)).toBe(Math.floor(0.5 * 1000));
		expect(b(2)).toBe(Math.floor(0.5 * 2000));
		expect(b(3)).toBe(Math.floor(0.5 * 4000));
		expect(randomSpy).toHaveBeenCalledTimes(3);
	});

	test("the jitter window is half-open: 0 is attainable, cap is not", () => {
		const b = exponentialFullJitterBackoff({ delay: 1000 });

		vi.spyOn(Math, "random").mockReturnValue(0);
		expect(b(3)).toBe(0);

		// The largest value Math.random() can yield is just under 1, so the result
		// is strictly less than the cap (4000 at attempt 3).
		vi.spyOn(Math, "random").mockReturnValue(0.9999999999);
		expect(b(3)).toBeLessThan(4000);
		expect(b(3)).toBeGreaterThanOrEqual(3999);
	});

	test("respects the maxDelay cap on the jitter window", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.9999999999);
		const b = exponentialFullJitterBackoff({ delay: 1000, maxDelay: 5000 });
		// cap saturates at 5000 from attempt 4 onward; jittered value stays below it.
		expect(b(10)).toBeLessThan(5000);
		expect(b(10)).toBeGreaterThanOrEqual(4999);
	});

	test("stays within [0, cap) for unmocked randomness across many draws", () => {
		const b = exponentialFullJitterBackoff({ delay: 1000, maxDelay: 8000 });
		for (let attempt = 1; attempt <= 20; attempt++) {
			const cap = Math.min(8000, 1000 * 2 ** (attempt - 1));
			for (let i = 0; i < 50; i++) {
				const value = b(attempt);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThan(Math.max(1, cap));
				expect(Number.isInteger(value)).toBe(true);
			}
		}
	});
});

describe("defaultBackoff", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is exponential full-jitter with the documented defaults", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		// floor(0.5 * min(30000, 1000 * 2^(i-1)))
		expect(defaultBackoff(1)).toBe(500);
		expect(defaultBackoff(2)).toBe(1000);
		expect(defaultBackoff(6)).toBe(Math.floor(0.5 * DEFAULT_MAX_DELAY));
	});

	test("never exceeds the 30s cap", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.9999999999);
		expect(defaultBackoff(100)).toBeLessThan(DEFAULT_MAX_DELAY);
	});
});
