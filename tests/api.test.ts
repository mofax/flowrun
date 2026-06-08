import { describe, expect, test } from "vite-plus/test";

import flowrun, {
	defaultBackoff,
	exponentialBackoff,
	exponentialFullJitterBackoff,
	fixedBackoff,
	linearBackoff,
	StepFailedError,
	WorkflowFailedError,
} from "../src/index.ts";
import { setupTest } from "./helpers.ts";

// A minimal guard on the published surface: an accidental removal or rename of
// a re-export would otherwise compile and ship silently. This pins both the
// default export's shape and the named re-exports the README documents.

describe("public API surface", () => {
	test("default export exposes registerWorkflow and configure", () => {
		expect(typeof flowrun.registerWorkflow).toBe("function");
		expect(typeof flowrun.configure).toBe("function");
	});

	test("registerWorkflow returns a runnable workflow handle", () => {
		setupTest();
		const workflow = flowrun.registerWorkflow("noop", async () => "done");
		expect(typeof workflow.run).toBe("function");
	});

	test("backoff strategies are re-exported from the index", () => {
		expect(typeof fixedBackoff).toBe("function");
		expect(typeof linearBackoff).toBe("function");
		expect(typeof exponentialBackoff).toBe("function");
		expect(typeof exponentialFullJitterBackoff).toBe("function");
		expect(typeof defaultBackoff).toBe("function");
	});

	test("error classes are re-exported from the index", () => {
		expect(typeof StepFailedError).toBe("function");
		expect(typeof WorkflowFailedError).toBe("function");
	});
});
