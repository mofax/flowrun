import type { SerializedError } from "./errors.ts";

export type RunId = string;
export type StepName = string;
export type RunStatus = "running" | "completed" | "failed";
export type StepStatus = "running" | "completed" | "failed";

export interface StepEntry {
	name: StepName;
	status: StepStatus;
	result?: unknown;
	error?: SerializedError;
	attempts: number;
	wakeAt?: number;
}

export interface RunRecord {
	runId: RunId;
	name: string;
	status: RunStatus;
	args: unknown[];
	output?: unknown;
	error?: SerializedError;
}

export interface RunState {
	run: RunRecord;
	steps: Map<StepName, StepEntry>;
}

export type GlobalState = Map<RunId, RunState>;

export type FlushScope =
	| { scope: "step"; runId: RunId; name: StepName }
	| { scope: "run"; runId: RunId }
	| { scope: "global" };

export interface Persistence {
	flush(scope: FlushScope): Promise<void>;
	load(scope: FlushScope): Promise<unknown>;
}

export type BackoffStrategy = (attempt: number) => number;

export interface StepOptions {
	retries?: number;
	backoff?: BackoffStrategy;
}

export interface WorkflowRunOptions {
	retries?: number;
	backoff?: BackoffStrategy;
}

export interface StepContext {
	stepName: string;
	attempt: number;
	runId: string;
}

export interface WorkflowContext<Args extends unknown[]> {
	args: Args;
	runId: string;
	step: {
		run<T>(name: string, fn: (s: StepContext) => Promise<T>, opts?: StepOptions): Promise<T>;
		sleep(name: string, ms: number): Promise<void>;
	};
}

export interface Workflow<Args extends unknown[], Out> {
	run(input: { args: Args }, opts?: WorkflowRunOptions): Promise<Out>;
}

export interface FlowrunConfig {
	serializeError?: (err: unknown) => SerializedError;
	deserializeError?: (e: SerializedError) => unknown;
}

export type WorkflowHandler<Args extends unknown[], Out> = (
	config: WorkflowContext<Args>,
) => Promise<Out>;
