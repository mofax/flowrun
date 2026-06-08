import { defaultBackoff } from "./backoff.ts";
import { getClock } from "./clock.ts";
import { getSerializeError } from "./config.ts";
import { StepFailedError, type SerializedError, WorkflowFailedError } from "./errors.ts";
import { generateRunId } from "./id.ts";
import { getSleepScheduler } from "./scheduler.ts";
import { getStore } from "./store.ts";
import type {
	RunState,
	StepContext,
	StepName,
	StepOptions,
	WorkflowContext,
	WorkflowHandler,
	WorkflowRunOptions,
} from "./types.ts";

type InflightMap = Map<StepName, Promise<unknown>>;

function commitValue<T>(value: T): T {
	return structuredClone(value);
}

function commitError(err: unknown): SerializedError {
	return structuredClone(getSerializeError()(err));
}

function getRunOrThrow(runId: string): RunState {
	const run = getStore().getRun(runId);
	if (!run) {
		throw new Error(`Run ${runId} not found`);
	}
	return run;
}

async function runWithRetries<T>(
	runId: string,
	name: StepName,
	fn: (ctx: StepContext) => Promise<T>,
	opts: StepOptions | undefined,
): Promise<T> {
	const retries = opts?.retries ?? 0;
	const backoff = opts?.backoff ?? defaultBackoff;
	const store = getStore();
	let attempt = 0;

	while (true) {
		attempt += 1;
		const stepContext: StepContext = {
			stepName: name,
			attempt,
			runId,
		};

		const existing = store.getStep(runId, name);
		if (existing?.status === "completed") {
			return existing.result as T;
		}

		store.setStep(runId, name, {
			name,
			status: "running",
			attempts: attempt,
			wakeAt: existing?.wakeAt,
		});

		try {
			const result = await fn(stepContext);
			const committed = commitValue(result);
			store.setStep(runId, name, {
				name,
				status: "completed",
				result: committed,
				attempts: attempt,
			});
			return committed as T;
		} catch (err) {
			if (attempt > retries) {
				store.setStep(runId, name, {
					name,
					status: "failed",
					error: commitError(err),
					attempts: attempt,
				});
				throw new StepFailedError(name, runId, err);
			}
			await getClock().sleep(backoff(attempt));
		}
	}
}

async function executeStepRun<T>(
	runId: string,
	name: StepName,
	fn: (ctx: StepContext) => Promise<T>,
	opts: StepOptions | undefined,
	inflight: InflightMap,
): Promise<T> {
	const store = getStore();
	const existing = store.getStep(runId, name);

	if (existing?.status === "completed") {
		return existing.result as T;
	}

	const pending = inflight.get(name);
	if (pending) {
		return (await pending) as T;
	}

	const promise = runWithRetries(runId, name, fn, opts);
	inflight.set(name, promise as Promise<unknown>);

	try {
		return await promise;
	} finally {
		inflight.delete(name);
	}
}

async function executeStepSleep(
	runId: string,
	name: StepName,
	ms: number,
	inflight: InflightMap,
): Promise<void> {
	const store = getStore();
	const existing = store.getStep(runId, name);

	if (existing?.status === "completed") {
		return;
	}

	const pending = inflight.get(name);
	if (pending) {
		await pending;
		return;
	}

	const promise = (async () => {
		const clock = getClock();
		let entry = store.getStep(runId, name);

		if (!entry?.wakeAt) {
			const wakeAt = clock.now() + ms;
			entry = {
				name,
				status: "running",
				attempts: entry?.attempts ?? 1,
				wakeAt,
			};
			store.setStep(runId, name, entry);
		}

		const remaining = entry.wakeAt! - clock.now();
		if (remaining > 0) {
			await getSleepScheduler().schedule(entry.wakeAt!);
		}

		store.setStep(runId, name, {
			name,
			status: "completed",
			attempts: entry.attempts,
			wakeAt: entry.wakeAt,
			result: null,
		});
	})();

	inflight.set(name, promise);
	try {
		await promise;
	} finally {
		inflight.delete(name);
	}
}

function createStepApi(runId: string, inflight: InflightMap) {
	return {
		run<T>(name: string, fn: (s: StepContext) => Promise<T>, opts?: StepOptions): Promise<T> {
			return executeStepRun(runId, name, fn, opts, inflight);
		},
		sleep(name: string, ms: number): Promise<void> {
			return executeStepSleep(runId, name, ms, inflight);
		},
	};
}

export async function executeWorkflow<Args extends unknown[], Out>(
	workflowName: string,
	handler: WorkflowHandler<Args, Out>,
	input: { args: Args },
	opts?: WorkflowRunOptions,
): Promise<Out> {
	const store = getStore();
	const runId = generateRunId();
	const committedArgs = commitValue([...input.args]);

	const runState: RunState = {
		run: {
			runId,
			name: workflowName,
			status: "running",
			args: committedArgs as unknown[],
		},
		steps: new Map(),
	};
	store.createRun(runState);

	const maxRetries = opts?.retries ?? 0;
	const backoff = opts?.backoff ?? defaultBackoff;
	const inflight: InflightMap = new Map();

	let attempt = 0;
	let lastError: unknown;

	while (true) {
		attempt += 1;
		inflight.clear();

		const context: WorkflowContext<Args> = {
			args: input.args,
			runId,
			step: createStepApi(runId, inflight),
		};

		try {
			const output = await handler(context);
			const committedOutput = commitValue(output);

			const current = getRunOrThrow(runId);
			current.run.status = "completed";
			current.run.output = committedOutput;
			store.updateRun(runId, current);

			return committedOutput as Out;
		} catch (err) {
			lastError = err;
			if (attempt > maxRetries) {
				break;
			}
			await getClock().sleep(backoff(attempt));
		}
	}

	const current = getRunOrThrow(runId);
	current.run.status = "failed";
	current.run.error = commitError(lastError);
	store.updateRun(runId, current);

	throw new WorkflowFailedError(workflowName, runId, lastError);
}
