import type {
	FlushScope,
	GlobalState,
	Persistence,
	RunId,
	RunState,
	StepEntry,
	StepName,
} from "./types.ts";

export type { FlushScope, Persistence };

export class Store {
	private readonly state: GlobalState = new Map();

	getRun(runId: RunId): RunState | undefined {
		return this.state.get(runId);
	}

	createRun(runState: RunState): void {
		this.state.set(runState.run.runId, runState);
	}

	updateRun(runId: RunId, runState: RunState): void {
		this.state.set(runId, runState);
	}

	getStep(runId: RunId, name: StepName) {
		return this.state.get(runId)?.steps.get(name);
	}

	setStep(runId: RunId, name: StepName, entry: StepEntry): void {
		const run = this.state.get(runId);
		if (!run) {
			throw new Error(`Run ${runId} not found`);
		}
		run.steps.set(name, entry);
	}

	getGlobalState(): GlobalState {
		return this.state;
	}
}

let sharedStore: Store | undefined;

export function getStore(): Store {
	if (!sharedStore) {
		sharedStore = new Store();
	}
	return sharedStore;
}

export function resetStore(): void {
	sharedStore = undefined;
}
