import { configure } from "./config.ts";
import { executeWorkflow } from "./engine.ts";
import type { Workflow, WorkflowHandler, WorkflowRunOptions } from "./types.ts";

export type {
	BackoffStrategy,
	FlushScope,
	FlowrunConfig,
	Persistence,
	StepContext,
	StepOptions,
	Workflow,
	WorkflowContext,
	WorkflowRunOptions,
} from "./types.ts";

export { StepFailedError, WorkflowFailedError, type SerializedError } from "./errors.ts";

export {
	exponentialBackoff,
	exponentialFullJitterBackoff,
	fixedBackoff,
	linearBackoff,
	defaultBackoff,
} from "./backoff.ts";

function registerWorkflow<Args extends unknown[], Out>(
	name: string,
	handler: WorkflowHandler<Args, Out>,
): Workflow<Args, Out> {
	return {
		run(input: { args: Args }, opts?: WorkflowRunOptions): Promise<Out> {
			return executeWorkflow(name, handler, input, opts);
		},
	};
}

const flowrun = {
	registerWorkflow,
	configure,
};

export default flowrun;
