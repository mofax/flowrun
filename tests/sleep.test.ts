import { expect, test } from "vite-plus/test";

import { fixedBackoff } from "../src/backoff.ts";
import { flowrun, setupTest } from "./helpers.ts";

test("step.sleep records wakeAt and waits remaining time", async () => {
	const clock = setupTest();

	const workflow = flowrun.registerWorkflow("sleep", async (config) => {
		await config.step.sleep("pause", 100);
		return "awake";
	});

	const resultPromise = workflow.run({ args: [] });
	await clock.advanceAsync(100);
	const result = await resultPromise;

	expect(result).toBe("awake");
});

test("replay skips elapsed sleep (I4)", async () => {
	const clock = setupTest();
	let workflowAttempts = 0;

	const workflow = flowrun.registerWorkflow("sleep-replay", async (config) => {
		workflowAttempts += 1;
		await config.step.sleep("pause", 50);

		if (workflowAttempts === 1) {
			throw new Error("fail after sleep");
		}

		return "done";
	});

	const resultPromise = workflow.run(
		{ args: [] },
		{ retries: 1, backoff: fixedBackoff({ delay: 0 }) },
	);

	await clock.advanceAsync(50);
	const result = await resultPromise;

	expect(result).toBe("done");
	expect(workflowAttempts).toBe(2);
});

test("concurrent identical sleeps dedupe via inflight", async () => {
	const clock = setupTest();

	// Two awaits on the same sleep step must collapse onto a single scheduled
	// wait rather than racing or double-suspending (executeStepSleep inflight).
	const workflow = flowrun.registerWorkflow("sleep-dedupe", async (config) => {
		await Promise.all([config.step.sleep("nap", 100), config.step.sleep("nap", 100)]);
		return "awake";
	});

	const resultPromise = workflow.run({ args: [] });
	await clock.advanceAsync(100);

	expect(await resultPromise).toBe("awake");
});

test("wakeAt is written once across replays", async () => {
	const clock = setupTest();
	const observedNow: number[] = [];

	const workflow = flowrun.registerWorkflow("wakeat", async (config) => {
		await config.step.sleep("pause", 30);
		observedNow.push(clock.now());
		throw new Error("retry me");
	});

	const runPromise = workflow.run(
		{ args: [] },
		{ retries: 1, backoff: fixedBackoff({ delay: 0 }) },
	);

	await clock.advanceAsync(30);
	await expect(runPromise).rejects.toThrow("retry me");

	expect(observedNow).toHaveLength(2);
	expect(observedNow[0]).toBe(observedNow[1]);
});
