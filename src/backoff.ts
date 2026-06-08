import type { BackoffStrategy } from "./types.ts";

export interface BackoffOptions {
	/** Base delay in milliseconds. Default: 1000 */
	delay?: number;
	/** Maximum delay cap in milliseconds. Default: 30000 */
	maxDelay?: number;
}

const DEFAULT_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;

function resolveOptions(options?: BackoffOptions): Required<BackoffOptions> {
	return {
		delay: options?.delay ?? DEFAULT_DELAY,
		maxDelay: options?.maxDelay ?? DEFAULT_MAX_DELAY,
	};
}

/** Constant delay: b(i) = d */
export function fixedBackoff(options?: BackoffOptions): BackoffStrategy {
	const { delay } = resolveOptions(options);
	return () => delay;
}

/** Linear delay: b(i) = d * i */
export function linearBackoff(options?: BackoffOptions): BackoffStrategy {
	const { delay } = resolveOptions(options);
	return (attempt) => delay * attempt;
}

/** Exponential delay: b(i) = min(d_max, d * 2^(i-1)) */
export function exponentialBackoff(options?: BackoffOptions): BackoffStrategy {
	const { delay, maxDelay } = resolveOptions(options);
	return (attempt) => Math.min(maxDelay, delay * 2 ** (attempt - 1));
}

/** Exponential + full jitter: Uniform(0, min(d_max, d * 2^(i-1))) — recommended default. */
export function exponentialFullJitterBackoff(options?: BackoffOptions): BackoffStrategy {
	const exponential = exponentialBackoff(options);
	return (attempt) => {
		const cap = exponential(attempt);
		return Math.floor(Math.random() * cap);
	};
}

export const defaultBackoff: BackoffStrategy = exponentialFullJitterBackoff();
