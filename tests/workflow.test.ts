import { expect, test } from "vite-plus/test";

import { flowrun, setupTest } from "./helpers.ts";

test("ADR context example runs successfully", async () => {
	setupTest();

	const workflow = flowrun.registerWorkflow("hello-world", async (config) => {
		const args = config.args;

		const step1output = await config.step.run("step-1", async () => {
			return `hello ${String(args[0])}`;
		});

		const step2output = await config.step.run("step-2", async () => {
			return `${step1output}!`;
		});

		return step2output;
	});

	const result = await workflow.run({ args: ["world"] });
	expect(result).toBe("hello world!");
});

test("each run gets a unique runId", async () => {
	setupTest();
	const runIds: string[] = [];

	const workflow = flowrun.registerWorkflow("ids", async (config) => {
		runIds.push(config.runId);
		return config.runId;
	});

	const a = await workflow.run({ args: [] });
	const b = await workflow.run({ args: [] });

	expect(a).not.toBe(b);
	expect(runIds).toHaveLength(2);
	expect(runIds[0]).not.toBe(runIds[1]);
});

test("workflow returns committed output", async () => {
	setupTest();

	const workflow = flowrun.registerWorkflow("output", async (config) => {
		return config.step.run("only", async () => ({ value: 42 }));
	});

	const result = await workflow.run({ args: [] });
	expect(result).toEqual({ value: 42 });
});
