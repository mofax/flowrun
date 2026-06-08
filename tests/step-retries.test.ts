import { expect, test } from "vite-plus/test";

import { fixedBackoff } from "../src/backoff.ts";
import { WorkflowFailedError } from "../src/errors.ts";
import { flowrun, setupTest } from "./helpers.ts";

test("per-step retries exhaust before workflow failure", async () => {
	setupTest();
	const attempts: number[] = [];

	const workflow = flowrun.registerWorkflow("step-retry", async (config) => {
		return config.step.run(
			"flaky",
			async (step) => {
				attempts.push(step.attempt);
				throw new Error("nope");
			},
			{ retries: 2, backoff: fixedBackoff({ delay: 0 }) },
		);
	});

	await expect(workflow.run({ args: [] })).rejects.toBeInstanceOf(WorkflowFailedError);
	expect(attempts).toEqual([1, 2, 3]);
});

test("StepContext.attempt is 1-indexed", async () => {
	setupTest();

	const workflow = flowrun.registerWorkflow("attempt-index", async (config) => {
		return config.step.run("check", async (step) => step.attempt);
	});

	const attempt = await workflow.run({ args: [] });
	expect(attempt).toBe(1);
});
