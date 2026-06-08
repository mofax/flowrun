# flowrun

A durable execution engine for TypeScript. Author a workflow as a normal async function composed of named **steps**.

v1 is **in-memory only**: state lives in RAM for the process lifetime.

## Install

```bash
npm install @mofax/flowrun
```

## Quick start

```ts
import flowrun from "@mofax/flowrun";

const workflow = flowrun.registerWorkflow("hello-world", async (config) => {
	const args = config.args;

	const greeting = await config.step.run("step-1", async () => {
		return `hello ${String(args[0])}`;
	});

	return config.step.run("step-2", async () => {
		return `${greeting}!`;
	});
});

try {
	const result = await workflow.run({ args: ["world"] }, { retries: 3 });
	console.log(result); // "hello world!"
} catch (error) {
	console.error("Workflow failed after all retries");
	console.error(error);
}
```

## How it works

On `workflow.run()`, the engine:

1. Creates a **workflow run** with a unique `runId` and an empty **journal**.
2. Invokes your handler with a `WorkflowContext` exposing `step.run` and `step.sleep`.
3. For each `step.run(name, fn)`:
   - If the journal already has a **completed** entry for `name`, returns the stored result and **does not call `fn`** (replay).
   - Otherwise executes `fn`, stores the result, and returns it.
4. If the handler throws and workflow-level retries remain, re-invokes the handler with the **same `runId` and journal**. Completed steps replay instantly; only failed and remaining steps execute.

```
run() ──▶ attempt 1: step-1 ✓ (run)   step-2 ✗ (throws)
          └─ retries remain ─▶
          attempt 2: step-1 ✓ (replay) step-2 ✓ (run) ─▶ completed
```

## API

### `flowrun.registerWorkflow(name, handler)`

Registers a named workflow. Returns a `Workflow` handle with a `.run()` method.

```ts
const wf = flowrun.registerWorkflow<[string], string>("my-workflow", async (ctx) => {
	// ctx.args, ctx.runId, ctx.step
});
```

### `workflow.run(input, opts?)`

Starts a new run. Each call gets a fresh `runId`.

| Option    | Type              | Default                 | Description                                                      |
| --------- | ----------------- | ----------------------- | ---------------------------------------------------------------- |
| `retries` | `number`          | `0`                     | Extra attempts after the first failure. `0` = one attempt total. |
| `backoff` | `BackoffStrategy` | exponential full jitter | Delay before each workflow-level retry.                          |

### `config.step.run(name, fn, opts?)`

Runs a memoized step. `fn` receives a `StepContext`:

| Field      | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `stepName` | The step name passed to `run`.                                     |
| `attempt`  | 1-indexed attempt number for **this step** (useful for flaky I/O). |
| `runId`    | The current workflow run id.                                       |

| Option    | Type              | Default                 | Description                                              |
| --------- | ----------------- | ----------------------- | -------------------------------------------------------- |
| `retries` | `number`          | `0`                     | Extra attempts after the first failure within this step. |
| `backoff` | `BackoffStrategy` | exponential full jitter | Delay before each step-level retry.                      |

### `config.step.sleep(name, ms)`

Durable timer. Records a `wakeAt` timestamp in the journal on first call. On replay:

- If `now >= wakeAt`, returns immediately.
- Otherwise waits only the **remaining** time.

Total wall-clock sleep across retries converges to the originally requested duration — the deadline is never reset.

### `flowrun.configure(opts)`

Global configuration. Currently supports error serialization hooks:

```ts
flowrun.configure({
	serializeError(err) {
		// return a plain, structuredClone-able object
		return { name: "MyError", message: String(err), code: 42 };
	},
	deserializeError(e) {
		return new MyError(e.message, e.code as number);
	},
});
```

The built-in encoder produces `{ name, message, stack?, cause? }`.

## Retries

Two independent levels:

1. **Per-step** — `step.run(name, fn, { retries })` retries `fn` locally before the step is considered failed.
2. **Workflow** — `workflow.run(input, { retries })` replays completed steps and resumes from the first incomplete step.

**Precedence:** a step exhausts its own retries first → the step fails → the failure propagates to the workflow → a workflow-level retry replays completed steps and re-executes the failed step.

Worst-case attempts for a single step: `(step.retries + 1) × (workflow.retries + 1)`.

## Backoff

A `BackoffStrategy` is `(attempt: number) => number` returning delay in milliseconds. Built-in strategies (all accept `{ delay?, maxDelay? }`):

```ts
import {
	fixedBackoff,
	linearBackoff,
	exponentialBackoff,
	exponentialFullJitterBackoff, // default
} from "@mofax/flowrun";

await workflow.run(
	{ args: [] },
	{
		retries: 3,
		backoff: exponentialFullJitterBackoff({ delay: 500, maxDelay: 30_000 }),
	},
);
```

Exponential full jitter (`Uniform(0, min(maxDelay, delay × 2^(attempt-1)))`) is the recommended default — it decorrelates retries across concurrent runs.

## Parallel steps

Use ordinary JavaScript:

```ts
const [a, b] = await Promise.all([
	config.step.run("fetch-a", () => fetchA()),
	config.step.run("fetch-b", () => fetchB()),
]);
```

The engine handles concurrent in-flight steps. Step names must be **unique** across parallel branches. Duplicate names resolve via first-writer-wins deduplication — only one execution of `fn` runs, and all callers share the result.

## Determinism contract

The workflow body must be **deterministic relative to the journal**: all I/O, randomness, clock reads, and side effects must go through `step.run` or `step.sleep`. Non-deterministic code in the workflow body (outside steps) breaks replay alignment.

v1 does not enforce this statically. Step names must be **stable and unique** within a run, and issued identically across replays.

## Errors

| Error                 | When                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `StepFailedError`     | A step exhausted its own retries. Carries `stepName`, `runId`, `cause`.     |
| `WorkflowFailedError` | Workflow-level retries exhausted. Carries `workflowName`, `runId`, `cause`. |

When a step returns a non-cloneable value (e.g. a function), `structuredClone` throws and the step fails.

## v1 limitations

- **In-memory only.** State is lost on process exit. `flush` / `load` / `resume` and the `Persistence` interface are designed but not implemented.
- **Short-to-medium-lived runs.** In-flight runs (including parked `step.sleep`) occupy RAM for their full lifetime.
- **At-least-once for interrupted steps** will apply once flush/resume lands. Steps with external side effects should be idempotent.
- **No** signals, cron, cancellation, timeouts, or run-history APIs yet.

## Development

Requires [Vite+](https://viteplus.dev/) (`vp`).

```bash
vp install    # install dependencies
vp check      # format, lint, typecheck
vp test       # run tests
vp pack       # build to dist/
```

## License

MIT
