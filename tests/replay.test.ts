import { expect, test } from "vite-plus/test";

import { fixedBackoff } from "../src/backoff.ts";
import { flowrun, setupTest } from "./helpers.ts";

test("workflow retry replays completed steps and re-executes failed step", async () => {
	setupTest();
	let step1Calls = 0;
	let step2Calls = 0;
	let workflowAttempts = 0;

	const workflow = flowrun.registerWorkflow("replay", async (config) => {
		workflowAttempts += 1;

		await config.step.run("step-1", async () => {
			step1Calls += 1;
			return "one";
		});

		await config.step.run("step-2", async () => {
			step2Calls += 1;
			if (step2Calls === 1) {
				throw new Error("transient");
			}
			return "two";
		});

		return "done";
	});

	const resultPromise = workflow.run(
		{ args: [] },
		{ retries: 1, backoff: fixedBackoff({ delay: 0 }) },
	);

	const result = await resultPromise;

	expect(result).toBe("done");
	expect(workflowAttempts).toBe(2);
	expect(step1Calls).toBe(1);
	expect(step2Calls).toBe(2);
});
