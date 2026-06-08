import { describe, expect, test } from "vite-plus/test";

import {
	defaultDeserializeError,
	defaultSerializeError,
	type SerializedError,
	StepFailedError,
	WorkflowFailedError,
} from "../src/errors.ts";
import { getStore } from "../src/store.ts";
import { flowrun, setupTest } from "./helpers.ts";

// Error handling spans three concerns that were previously under- or un-tested:
// the structured (de)serialization round-trip (deserialize had *zero*
// coverage), the message/field construction of the two domain error classes,
// and the integration path that persists a serialized error onto the run. The
// prior integration test for the default serializer also passed vacuously
// (assertions lived inside a try/catch with no `expect.assertions`), so it is
// rewritten here as a `rejects` assertion.

describe("StepFailedError", () => {
	test("interpolates an Error cause's message and exposes context fields", () => {
		const cause = new Error("disk full");
		const err = new StepFailedError("persist", "run-1", cause);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("StepFailedError");
		expect(err.message).toBe('Step "persist" failed: disk full');
		expect(err.stepName).toBe("persist");
		expect(err.runId).toBe("run-1");
		expect(err.cause).toBe(cause);
	});

	test("omits the colon detail for a non-Error cause", () => {
		const err = new StepFailedError("persist", "run-1", "boom");
		expect(err.message).toBe('Step "persist" failed');
		expect(err.cause).toBe("boom");
	});
});

describe("WorkflowFailedError", () => {
	test("interpolates an Error cause's message and exposes context fields", () => {
		const cause = new Error("nope");
		const err = new WorkflowFailedError("checkout", "run-9", cause);
		expect(err.name).toBe("WorkflowFailedError");
		expect(err.message).toBe('Workflow "checkout" failed: nope');
		expect(err.workflowName).toBe("checkout");
		expect(err.runId).toBe("run-9");
		expect(err.cause).toBe(cause);
	});

	test("omits the colon detail for a non-Error cause", () => {
		expect(new WorkflowFailedError("checkout", "run-9", 42).message).toBe(
			'Workflow "checkout" failed',
		);
	});
});

describe("defaultSerializeError", () => {
	test("captures name, message and stack of an Error", () => {
		const err = new TypeError("bad arg");
		const s = defaultSerializeError(err);
		expect(s.name).toBe("TypeError");
		expect(s.message).toBe("bad arg");
		expect(typeof s.stack).toBe("string");
	});

	test("recursively serializes the cause chain", () => {
		const root = new Error("root");
		const mid = new Error("mid", { cause: root });
		const top = new Error("top", { cause: mid });
		const s = defaultSerializeError(top);
		expect(s.message).toBe("top");
		expect(s.cause?.message).toBe("mid");
		expect(s.cause?.cause?.message).toBe("root");
		expect(s.cause?.cause?.cause).toBeUndefined();
	});

	test("coerces a non-Error throw into a structural Error shape", () => {
		expect(defaultSerializeError("just a string")).toEqual({
			name: "Error",
			message: "just a string",
		});
		expect(defaultSerializeError(123)).toEqual({ name: "Error", message: "123" });
	});

	test("passes an already-serialized error through unchanged", () => {
		const already: SerializedError = { name: "DomainError", message: "x", code: 7 };
		expect(defaultSerializeError(already)).toBe(already);
	});

	test("omits an absent stack rather than emitting undefined", () => {
		const err = new Error("no stack");
		err.stack = undefined;
		expect("stack" in defaultSerializeError(err)).toBe(false);
	});
});

describe("defaultDeserializeError", () => {
	test("reconstructs an Error preserving name and message", () => {
		const err = defaultDeserializeError({ name: "RangeError", message: "out of range" });
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("RangeError");
		expect(err.message).toBe("out of range");
	});

	test("reconstructs the nested cause chain", () => {
		const err = defaultDeserializeError({
			name: "Error",
			message: "top",
			cause: { name: "Error", message: "root" },
		});
		expect((err.cause as Error).message).toBe("root");
	});

	test("round-trips name, message and cause through serialize -> deserialize", () => {
		const original = new Error("outer", { cause: new TypeError("inner") });
		const restored = defaultDeserializeError(defaultSerializeError(original));
		expect(restored.name).toBe("Error");
		expect(restored.message).toBe("outer");
		expect((restored.cause as Error).name).toBe("TypeError");
		expect((restored.cause as Error).message).toBe("inner");
	});
});

describe("error integration with the engine", () => {
	test("default serialization persists a structural error on the failed run", async () => {
		setupTest();

		const workflow = flowrun.registerWorkflow("structural", async () => {
			throw new Error("boom");
		});

		await expect(workflow.run({ args: [] })).rejects.toMatchObject({
			name: "WorkflowFailedError",
			workflowName: "structural",
		});
	});

	test("custom serializeError hook is invoked and its output is persisted", async () => {
		setupTest();

		class DomainError extends Error {
			readonly code: number;
			constructor(code: number) {
				super(`domain ${code}`);
				this.name = "DomainError";
				this.code = code;
			}
		}

		flowrun.configure({
			serializeError(err: unknown): SerializedError {
				if (err instanceof DomainError) {
					return { name: err.name, message: err.message, code: err.code };
				}
				return { name: "Error", message: String(err) };
			},
		});

		const workflow = flowrun.registerWorkflow("domain", async () => {
			throw new DomainError(42);
		});

		const rejection = await workflow.run({ args: [] }).then(
			() => {
				throw new Error("expected workflow to reject");
			},
			(err: unknown) => err as WorkflowFailedError,
		);

		expect(rejection).toBeInstanceOf(WorkflowFailedError);
		// The custom serializer's `code` field must survive onto the persisted run.
		const persisted = getStore().getRun(rejection.runId)?.run.error;
		expect(persisted).toMatchObject({ name: "DomainError", message: "domain 42", code: 42 });
	});
});
