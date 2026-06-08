import { afterEach, describe, expect, test } from "vite-plus/test";

import { getStore, resetStore, Store } from "../src/store.ts";
import type { RunState, StepEntry } from "../src/types.ts";

// The in-memory Store is the single source of truth for run/step durability.
// Its CRUD surface and — importantly — its invariant that a step cannot be
// written against an unknown run had no direct coverage.

function runState(runId: string): RunState {
	return {
		run: { runId, name: "wf", status: "running", args: [] },
		steps: new Map(),
	};
}

function stepEntry(name: string): StepEntry {
	return { name, status: "completed", attempts: 1, result: name };
}

afterEach(() => {
	resetStore();
});

describe("Store", () => {
	test("createRun then getRun round-trips the run state", () => {
		const store = new Store();
		const state = runState("r1");
		store.createRun(state);
		expect(store.getRun("r1")).toBe(state);
	});

	test("getRun returns undefined for an unknown run", () => {
		expect(new Store().getRun("missing")).toBeUndefined();
	});

	test("updateRun replaces the stored run state", () => {
		const store = new Store();
		store.createRun(runState("r1"));
		const next = runState("r1");
		next.run.status = "completed";
		store.updateRun("r1", next);
		expect(store.getRun("r1")).toBe(next);
		expect(store.getRun("r1")?.run.status).toBe("completed");
	});

	test("setStep then getStep round-trips a step entry", () => {
		const store = new Store();
		store.createRun(runState("r1"));
		const entry = stepEntry("s1");
		store.setStep("r1", "s1", entry);
		expect(store.getStep("r1", "s1")).toBe(entry);
	});

	test("setStep throws when the run does not exist", () => {
		const store = new Store();
		expect(() => store.setStep("ghost", "s1", stepEntry("s1"))).toThrow("Run ghost not found");
	});

	test("getStep returns undefined for a missing run or missing step", () => {
		const store = new Store();
		expect(store.getStep("ghost", "s1")).toBeUndefined();
		store.createRun(runState("r1"));
		expect(store.getStep("r1", "absent")).toBeUndefined();
	});

	test("getGlobalState exposes the live run map", () => {
		const store = new Store();
		store.createRun(runState("r1"));
		const global = store.getGlobalState();
		expect(global.has("r1")).toBe(true);
		expect(global.size).toBe(1);
	});
});

describe("getStore / resetStore", () => {
	test("getStore returns a stable singleton", () => {
		resetStore();
		expect(getStore()).toBe(getStore());
	});

	test("resetStore yields a fresh, empty instance", () => {
		const a = getStore();
		a.createRun(runState("r1"));
		resetStore();
		const b = getStore();
		expect(b).not.toBe(a);
		expect(b.getRun("r1")).toBeUndefined();
	});
});
