export interface Clock {
	/** Wall-clock milliseconds (for durable wakeAt timestamps). */
	now(): number;
	/** Monotonic milliseconds (for relative waits, immune to wall-clock skew). */
	monotonicNow(): number;
	sleep(ms: number): Promise<void>;
}

class DefaultClock implements Clock {
	private readonly origin = performance.now();

	now(): number {
		return Date.now();
	}

	monotonicNow(): number {
		return performance.now() - this.origin;
	}

	sleep(ms: number): Promise<void> {
		if (ms <= 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
}

let currentClock: Clock = new DefaultClock();

export function getClock(): Clock {
	return currentClock;
}

export function setClock(clock: Clock): void {
	currentClock = clock;
}

export function resetClock(): void {
	currentClock = new DefaultClock();
}
