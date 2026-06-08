import { expect, test } from "vite-plus/test";

import { fixedBackoff } from "../src/backoff.ts";
import { WorkflowFailedError } from "../src/errors.ts";
import { flowrun, setupTest } from "./helpers.ts";

test("workflow-level retries succeed on later attempt", async () => {
	setupTest();
	let attempts = 0;

	const workflow = flowrun.registerWorkflow("wf-retry", async () => {
		attempts += 1;
		if (attempts < 2) {
			throw new Error("workflow fail");
		}
		return "ok";
	});

	const result = await workflow.run(
		{ args: [] },
		{ retries: 1, backoff: fixedBackoff({ delay: 0 }) },
	);

	expect(result).toBe("ok");
	expect(attempts).toBe(2);
});

test("WorkflowFailedError thrown when workflow retries exhausted", async () => {
	setupTest();

	const workflow = flowrun.registerWorkflow("wf-fail", async () => {
		throw new Error("always fails");
	});

	await expect(workflow.run({ args: [] }, { retries: 0 })).rejects.toBeInstanceOf(
		WorkflowFailedError,
	);
});
