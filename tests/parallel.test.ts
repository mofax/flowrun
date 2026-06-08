import { expect, test } from "vite-plus/test";

import { flowrun, setupTest } from "./helpers.ts";

test("parallel distinct steps both execute and commit", async () => {
	setupTest();
	const calls: string[] = [];

	const workflow = flowrun.registerWorkflow("parallel", async (config) => {
		const [a, b] = await Promise.all([
			config.step.run("a", async () => {
				calls.push("a");
				return 1;
			}),
			config.step.run("b", async () => {
				calls.push("b");
				return 2;
			}),
		]);
		return a + b;
	});

	const result = await workflow.run({ args: [] });
	expect(result).toBe(3);
	expect(calls.sort()).toEqual(["a", "b"]);
});

test("duplicate step names dedupe via inflight (I2)", async () => {
	setupTest();
	let executions = 0;

	const workflow = flowrun.registerWorkflow("dedupe", async (config) => {
		const [x, y] = await Promise.all([
			config.step.run("same", async () => {
				executions += 1;
				return "shared";
			}),
			config.step.run("same", async () => {
				executions += 1;
				return "shared";
			}),
		]);
		return x === y ? executions : -1;
	});

	const result = await workflow.run({ args: [] });
	expect(result).toBe(1);
});
