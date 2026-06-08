import { getClock } from "./clock.ts";

interface ScheduledTimer {
	wakeAt: number;
	resolve: () => void;
}

/**
 * Shared min-heap scheduler keyed by `wakeAt` (ADR §11.6).
 *
 * A single "driver" timer is armed against the *earliest* pending deadline.
 * When it elapses, every timer that is now due is fired in ascending `wakeAt`
 * order and the driver is re-armed for the next deadline.
 *
 * Preemption: because {@link Clock.sleep} exposes no cancellation, a driver that
 * is already sleeping cannot be shortened in place. Instead, scheduling a timer
 * whose deadline is *earlier* than the one the live driver targets supersedes
 * that driver via a monotonically increasing {@link epoch}: a fresh driver is
 * armed for the new minimum, and when the stale driver eventually elapses its
 * continuation observes the epoch mismatch and becomes a no-op. This keeps
 * firing times correct at the cost of at most one redundant pending timer per
 * supersession.
 */
export class SleepScheduler {
	private readonly heap: ScheduledTimer[] = [];
	/** Deadline the currently-live driver is sleeping until, or undefined. */
	private armedFor: number | undefined;
	/** Generation counter; only the driver whose epoch matches may fire. */
	private epoch = 0;

	schedule(wakeAt: number): Promise<void> {
		return new Promise((resolve) => {
			this.heap.push({ wakeAt, resolve });
			this.bubbleUp(this.heap.length - 1);
			this.arm();
		});
	}

	/**
	 * Ensure a driver is sleeping until the current heap minimum. Idempotent: a
	 * no-op when the live driver already targets that deadline (or an earlier
	 * one); otherwise (re-)arms, superseding any later-targeted driver.
	 */
	private arm(): void {
		if (this.heap.length === 0) {
			return;
		}

		const target = this.heap[0]!.wakeAt;
		if (this.armedFor !== undefined && this.armedFor <= target) {
			return;
		}

		this.armedFor = target;
		const myEpoch = ++this.epoch;
		const delay = Math.max(0, target - getClock().now());

		void getClock()
			.sleep(delay)
			.then(() => {
				if (myEpoch !== this.epoch) {
					return; // superseded by a sooner deadline; a newer driver owns firing.
				}
				this.armedFor = undefined;
				this.fireDue();
			});
	}

	private fireDue(): void {
		const now = getClock().now();

		while (this.heap.length > 0 && this.heap[0]!.wakeAt <= now) {
			const timer = this.popMin();
			timer.resolve();
		}

		this.arm();
	}

	private bubbleUp(index: number): void {
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (this.heap[parent]!.wakeAt <= this.heap[index]!.wakeAt) {
				break;
			}
			this.swap(parent, index);
			index = parent;
		}
	}

	private bubbleDown(index: number): void {
		const length = this.heap.length;

		while (true) {
			const left = index * 2 + 1;
			const right = index * 2 + 2;
			let smallest = index;

			if (left < length && this.heap[left]!.wakeAt < this.heap[smallest]!.wakeAt) {
				smallest = left;
			}
			if (right < length && this.heap[right]!.wakeAt < this.heap[smallest]!.wakeAt) {
				smallest = right;
			}
			if (smallest === index) {
				break;
			}
			this.swap(index, smallest);
			index = smallest;
		}
	}

	private popMin(): ScheduledTimer {
		const min = this.heap[0]!;
		const last = this.heap.pop();
		if (this.heap.length > 0 && last !== undefined) {
			this.heap[0] = last;
			this.bubbleDown(0);
		}
		return min;
	}

	private swap(a: number, b: number): void {
		const tmp = this.heap[a]!;
		this.heap[a] = this.heap[b]!;
		this.heap[b] = tmp;
	}
}

let sharedScheduler: SleepScheduler | undefined;

export function getSleepScheduler(): SleepScheduler {
	if (!sharedScheduler) {
		sharedScheduler = new SleepScheduler();
	}
	return sharedScheduler;
}

export function resetSleepScheduler(): void {
	sharedScheduler = undefined;
}
