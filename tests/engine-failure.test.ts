import { describe, expect, test } from "vite-plus/test";

import { fixedBackoff } from "../src/backoff.ts";
import { StepFailedError, WorkflowFailedError } from "../src/errors.ts";
import { getStore } from "../src/store.ts";
import { flowrun, flushMicrotasks, setupTest } from "./helpers.ts";

// Failure-path coverage was almost entirely return-value based: tests asserted
// the *type* of the outer rejection but never inspected the wrapped cause
// chain, the persisted run/step records, the recorded attempt counts, or that
// retries actually wait on the clock (every prior retry test used delay: 0).

async function runToRejection(promise: Promise<unknown>): Promise<WorkflowFailedError> {
	return promise.then(
		() => {
			throw new Error("expected workflow to reject");
		},
		(err: unknown) => err as WorkflowFailedError,
	);
}

describe("failure cause chain", () => {
	test("WorkflowFailedError wraps StepFailedError wraps the original error", async () => {
		setupTest();

		const workflow = flowrun.registerWorkflow("wrap", async (config) => {
			return config.step.run("x", async () => {
				throw new Error("boom");
			});
		});

		const err = await runToRejection(workflow.run({ args: [] }, { retries: 0 }));

		expect(err).toBeInstanceOf(WorkflowFailedError);
		expect(err.workflowName).toBe("wrap");

		expect(err.cause).toBeInstanceOf(StepFailedError);
		const stepErr = err.cause as StepFailedError;
		expect(stepErr.stepName).toBe("x");
		expect(stepErr.runId).toBe(err.runId);
		expect((stepErr.cause as Error).message).toBe("boom");
	});
});

describe("persisted failure records", () => {
	test("the run is marked failed with a serialized error", async () => {
		setupTest();

		const workflow = flowrun.registerWorkflow("persist-fail", async (config) => {
			return config.step.run("x", async () => {
				throw new Error("boom");
			});
		});

		const err = await runToRejection(workflow.run({ args: [] }, { retries: 0 }));

		const run = getStore().getRun(err.runId)?.run;
		expect(run?.status).toBe("failed");
		expect(run?.error?.message).toBe('Step "x" failed: boom');
	});

	test("the failing step records status, serialized error and attempt count", async () => {
		setupTest();

		const workflow = flowrun.registerWorkflow("step-attempts", async (config) => {
			return config.step.run(
				"flaky",
				async () => {
					throw new Error("nope");
				},
				{ retries: 2, backoff: fixedBackoff({ delay: 0 }) },
			);
		});

		const err = await runToRejection(workflow.run({ args: [] }, { retries: 0 }));

		const step = getStore().getRun(err.runId)?.steps.get("flaky");
		expect(step?.status).toBe("failed");
		expect(step?.attempts).toBe(3); // 1 initial + 2 retries
		expect(step?.error?.message).toBe("nope");
	});
});

describe("retry timing actually waits on the clock", () => {
	test("a backoff delay suspends the retry until virtual time advances", async () => {
		const clock = setupTest();
		let calls = 0;

		const workflow = flowrun.registerWorkflow("backoff-timing", async (config) => {
			return config.step.run(
				"s",
				async () => {
					calls += 1;
					if (calls === 1) {
						throw new Error("transient");
					}
					return "ok";
				},
				{ retries: 1, backoff: fixedBackoff({ delay: 100 }) },
			);
		});

		const resultPromise = workflow.run({ args: [] });

		// Let the first attempt run, throw, and suspend on the 100ms backoff sleep.
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Not enough time elapsed — the retry must still be parked.
		await clock.advanceAsync(99);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Cross the backoff threshold; the retry now runs and the step succeeds.
		await clock.advanceAsync(1);
		await expect(resultPromise).resolves.toBe("ok");
		expect(calls).toBe(2);
	});
});
