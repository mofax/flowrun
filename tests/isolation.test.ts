import { describe, expect, test } from "vite-plus/test";

import { WorkflowFailedError } from "../src/errors.ts";
import { getStore } from "../src/store.ts";
import { flowrun, setupTest } from "./helpers.ts";

// The engine's central durability guarantee is the *commit boundary*: every
// value that crosses into the store (workflow args, step results, workflow
// output) is deep-cloned via structuredClone, so that subsequent mutation of
// the caller's source object cannot retroactively corrupt persisted state. This
// invariant is the entire reason `commitValue` exists, and nothing previously
// asserted it. These tests mutate the source *after* commit and prove the
// stored snapshot is unaffected.

describe("commit boundary isolation", () => {
	test("workflow args are snapshotted independently of the caller's object", async () => {
		setupTest();
		const arg = { items: [1, 2] };
		let runId = "";

		const workflow = flowrun.registerWorkflow("args-isolation", async (config) => {
			runId = config.runId;
			return config.runId;
		});

		await workflow.run({ args: [arg] });

		// Mutating the caller's object after the run must not touch stored args.
		arg.items.push(3);

		expect(getStore().getRun(runId)?.run.args).toEqual([{ items: [1, 2] }]);
	});

	test("step results are deep-cloned, isolating nested mutation of the source", async () => {
		setupTest();
		const source = { n: 1, nested: { v: 1 } };
		let runId = "";

		const workflow = flowrun.registerWorkflow("commit-isolation", async (config) => {
			runId = config.runId;
			await config.step.run("s", async () => source);
			return config.runId;
		});

		await workflow.run({ args: [] });

		source.n = 999;
		source.nested.v = 999;

		expect(getStore().getRun(runId)?.steps.get("s")?.result).toEqual({
			n: 1,
			nested: { v: 1 },
		});
	});

	test("workflow output is snapshotted independently of the caller's object", async () => {
		setupTest();
		const source = { total: 1 };
		let runId = "";

		const workflow = flowrun.registerWorkflow("output-isolation", async (config) => {
			runId = config.runId;
			return source;
		});

		await workflow.run({ args: [] });
		source.total = 999;

		expect(getStore().getRun(runId)?.run.output).toEqual({ total: 1 });
	});

	test("a non-cloneable step result surfaces as a step failure (documented sharp edge)", async () => {
		setupTest();

		// structuredClone cannot clone a function; the commit happens *after* the
		// step body resolves, so an unserializable return is reported as a step
		// failure rather than a success. This encodes the current behaviour.
		const workflow = flowrun.registerWorkflow("noclone", async (config) => {
			return config.step.run("bad", async () => () => 1);
		});

		const rejection = await workflow.run({ args: [] }, { retries: 0 }).then(
			() => {
				throw new Error("expected workflow to reject");
			},
			(err: unknown) => err as WorkflowFailedError,
		);

		expect(rejection).toBeInstanceOf(WorkflowFailedError);
		expect(getStore().getRun(rejection.runId)?.steps.get("bad")?.status).toBe("failed");
	});
});
