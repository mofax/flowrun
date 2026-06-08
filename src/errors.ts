import type { RunId, StepName } from "./types.ts";

export interface SerializedError {
	name: string;
	message: string;
	stack?: string;
	cause?: SerializedError;
	workflowName?: string;
	runId?: RunId;
	stepName?: StepName;
	[key: string]: unknown;
}

export class StepFailedError extends Error {
	override readonly name = "StepFailedError";
	readonly stepName: StepName;
	readonly runId: RunId;
	readonly cause: unknown;

	constructor(stepName: StepName, runId: RunId, cause: unknown) {
		const message =
			cause instanceof Error
				? `Step "${stepName}" failed: ${cause.message}`
				: `Step "${stepName}" failed`;
		super(message);
		this.stepName = stepName;
		this.runId = runId;
		this.cause = cause;
	}
}

export class WorkflowFailedError extends Error {
	override readonly name = "WorkflowFailedError";
	readonly workflowName: string;
	readonly runId: RunId;
	readonly cause: unknown;

	constructor(workflowName: string, runId: RunId, cause: unknown) {
		const message =
			cause instanceof Error
				? `Workflow "${workflowName}" failed: ${cause.message}`
				: `Workflow "${workflowName}" failed`;
		super(message);
		this.workflowName = workflowName;
		this.runId = runId;
		this.cause = cause;
	}
}

export function defaultSerializeError(err: unknown): SerializedError {
	if (err instanceof Error) {
		const serialized: SerializedError = {
			name: err.name,
			message: err.message,
		};
		if (err.stack) {
			serialized.stack = err.stack;
		}
		if (err.cause !== undefined) {
			serialized.cause = defaultSerializeError(err.cause);
		}
		return serialized;
	}

	if (isSerializedError(err)) {
		return err;
	}

	return {
		name: "Error",
		message: String(err),
	};
}

export function defaultDeserializeError(e: SerializedError): Error {
	const err = new Error(e.message);
	err.name = e.name;
	if (e.stack) {
		err.stack = e.stack;
	}
	if (e.cause) {
		err.cause = defaultDeserializeError(e.cause);
	}
	return err;
}

function isSerializedError(value: unknown): value is SerializedError {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"message" in value &&
		typeof (value as SerializedError).name === "string" &&
		typeof (value as SerializedError).message === "string"
	);
}
