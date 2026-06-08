# ADR 000 — Initial Architecture: An In-Memory Durable Execution Engine

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** flowrun maintainers

---

## Context

`flowrun` is being built as a **durable execution engine** for TypeScript: a library that
lets you author a workflow as a normal async function composed of named _steps_, and have the
engine guarantee that already-completed steps are never re-executed when a workflow is
retried. The target public API is:

```ts
import flowrun from "@mofax/flowrun";

const workflow = flowrun.registerWorkflow("hello-world", async (config) => {
	const args = config.args;

	const step1output = await config.step.run("step-1", async (stepConfig) => {
		// step 1 logic; may read `args`
		return step1output;
	});

	const step2output = await config.step.run("step-2", async (stepConfig) => {
		// step 2 logic; may read `step1output`
		return step2output;
	});
});

try {
	await workflow.run({ args: ["world"] }, { retries: 3 });
} catch (error) {
	console.error("Workflow failed including all retries");
	console.error(error);
}
```

This ADR records the foundational architecture. The driving constraints:

1. **RAM is the authoritative working store — now and forever.** The engine executes against
   in-memory state and never does a per-step database round trip.
2. **Future durability is a flush-and-resume model, not a swappable backend.** A `flush()`
   serializes current in-memory state to a durable backend (DB, file, object store); a
   `resume()`/`load()` rehydrates a previously flushed snapshot so a run can continue later,
   possibly in a different process.
3. **Forward-thinking design.** Adding flush/resume later must not change the public workflow
   API.
4. **v1 scope (decided):** workflow-level retries **and** per-step retries; durable `step.run`,
   `step.sleep`, and parallel step execution.

---

## Decision

### 1. Core model

| Concept         | Description                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**    | A named, registered, deterministic async function. `registerWorkflow(name, handler)` returns a `Workflow` handle exposing `.run(input, opts)`.          |
| **WorkflowRun** | One execution instance: a unique `runId`, a `status` (`running \| completed \| failed`), input `args`, an optional `output`/`error`, and a **journal**. |
| **Step**        | A named, memoized unit of work inside a run. Its outcome is recorded in the journal keyed by `(runId, stepName)`.                                       |
| **Journal**     | The per-run record of step outcomes that makes replay possible.                                                                                         |
| **Store**       | The in-memory state holder. Authoritative at all times.                                                                                                 |
| **Engine**      | Orchestrates execution, journal replay, and retries.                                                                                                    |

### 2. Durable execution mechanism — replay + memoization

The durability guarantee comes from **replaying the journal** on every (re)invocation of the
workflow handler.

On `workflow.run(input, opts)`:

1. Create a `WorkflowRun` (fresh `runId`, status `running`) in the store.
2. Invoke the handler with a `WorkflowContext`. For each `step.run(name, fn)`:
   - If the journal already has a **completed** entry for `name`, return the persisted result
     and **skip `fn`** (replay).
   - Otherwise execute `fn`, persist the result as `completed`, and return it.
3. If the handler throws and **workflow-level retries remain**, re-invoke the handler with the
   **same `runId` and journal**. Completed steps replay instantly; only the failed and
   remaining steps actually execute. This is the durable-execution guarantee.
4. On success, mark the run `completed` and store the `output`. When retries are exhausted,
   mark the run `failed` and throw a wrapping error.

```
run()──▶ attempt 1: step-1 ✓ (run)   step-2 ✗ (run, throws)
         └─ retries remain ─▶
         attempt 2: step-1 ✓ (replay) step-2 ✓ (run)  ─▶ completed
```

### 3. Step identity & the determinism contract

- Steps are keyed **by name**, never by call order. Name-keying is what makes parallel steps
  and partial replay safe and unambiguous.
- Step names must be **unique and stable** within a run, and must be issued identically across
  replays.
- The workflow body must be **deterministic**: all I/O, randomness, clock reads, and side
  effects must go through `step.run` / `step.sleep`. Non-deterministic code in the workflow
  body (outside steps) breaks replay alignment.
- v1 documents this as a contract; it is **not** statically enforced. (A future version may
  add dev-mode detection of duplicate/unstable step names.)

### 4. Retries (two levels)

- **Per-step retries** — `step.run(name, fn, { retries?, backoff? })` retries `fn` locally,
  incrementing the entry's `attempts`, before the step is considered failed.
- **Workflow-level retries** — `run(input, { retries?, backoff? })` replays completed steps
  and resumes from the first incomplete step.
- **Precedence:** a step's own retries exhaust first → the step fails → the failure propagates
  to the workflow → a workflow-level retry replays completed steps and resumes from the failed
  step.
- **Backoff:** both levels accept a backoff strategy (e.g. fixed or exponential delay). The
  default is a sensible fixed/exponential value; `retries: 0` means a single attempt.

### 5. `step.sleep` — durable timer

- `await config.step.sleep(name, ms)` records a journal entry carrying a `wakeAt` timestamp.
- On replay: if `now >= wakeAt`, the sleep is already complete and returns immediately;
  otherwise the engine waits only the **remaining** time.
- v1 implements the wait with `setTimeout`. Because the durable fact is the journaled
  `wakeAt`, the behavior is replay-safe today and portable to a flushed/resumed snapshot
  later.

### 6. Parallel steps

- Parallelism uses ordinary JavaScript: `await Promise.all([step.run("a", …), step.run("b", …)])`.
- The engine tolerates multiple in-flight steps concurrently; name-keyed journaling keeps
  replay deterministic regardless of completion order.
- Constraint: step names must be unique even across parallel branches.

### 7. State model & persistence seam (RAM-first, flush-and-resume)

**RAM is authoritative, always.** The engine reads and writes the in-memory store
synchronously during execution. There is no per-step database round trip — now or in the
future.

The in-memory state is a single, **hierarchical and serializable** structure so that any
sub-tree can be serialized independently:

```ts
// global
type GlobalState = Map<RunId, RunState>;

// run
interface RunState {
	run: {
		runId: RunId;
		name: string; // workflow name
		status: "running" | "completed" | "failed";
		args: unknown[];
		output?: unknown;
		error?: SerializedError;
	};
	steps: Map<StepName, StepEntry>;
}

// step
interface StepEntry {
	name: StepName;
	status: "running" | "completed" | "failed";
	result?: unknown;
	error?: SerializedError;
	attempts: number;
	wakeAt?: number; // present for step.sleep entries
}
```

Each level — global, run, step — is independently serializable. This is precisely what
enables flushing at any granularity.

**Persistence is a snapshot boundary, not a backend.** The forward-thinking seam is a small
`Persistence` interface whose `flush` accepts a **scope**, supporting all three granularities:

```ts
type FlushScope =
	| { scope: "step"; runId: RunId; name: StepName } // persist one step entry
	| { scope: "run"; runId: RunId } // persist one run (record + all steps)
	| { scope: "global" }; // persist the entire global state

interface Persistence {
	flush(scope: FlushScope): Promise<void>;
	load(scope: FlushScope): Promise<unknown>; // rehydrate a step, a run, or everything
}
```

- `load` / `resume` mirror the same scopes to rehydrate a step, a run, or everything.
- **v1 ships only the in-memory store.** `flush` / `load` / `resume` are _designed-for_ but
  not implemented in this version.
- The engine will (in future) expose hooks such as `flowrun.flush(scope)` /
  `flowrun.resume(snapshot)` so a process can persist at the chosen granularity and a later
  process can rehydrate and continue in-flight runs. Natural flush points are documented:
  e.g. auto-`flush({ scope: "step" })` after each step completes, and
  `flush({ scope: "run" })` on run completion.

**Serializability is a hard requirement.** Step inputs/outputs/errors and all run state must
be **serializable through the engine's codec** (defined in §11.4), and the journal must never
rely on in-process object identity. This is exactly what makes a future `flush` / `resume`
possible.

The supported value set is defined **once, by the codec — not by whatever the in-memory clone
happens to allow.** This avoids a v1→v2 trap: if v1 silently passed through native `Map` /
`Set` / `Date` / `BigInt` (because an in-memory `structuredClone` handles them) while §7
nominally promised "JSON only", user code would compile and pass tests on v1 and then break
the moment a JSON-column backend is flushed to. Instead, the engine **officially supports an
extended type set** (objects, arrays, `string`/`number`/`boolean`/`null`, plus `Date`, `Map`,
`Set`, typed arrays, `BigInt`) via an internal codec that encodes them to a backend-portable
representation. Anything the codec cannot encode (functions, symbols, class instances,
cyclic-by-identity graphs) is rejected **eagerly at commit time in v1**, so the failure
surfaces in development rather than at the persistence boundary later.

**Model chosen: snapshot-per-step** (a run record plus name-keyed step records) rather than
full event-sourcing — it is the simplest representation in RAM and serializes cleanly.
Event-sourcing is recorded below as the considered alternative.

### 8. Error model

- `WorkflowFailedError` — thrown by `run()` when workflow-level retries are exhausted; wraps
  the final underlying cause.
- `StepFailedError` — represents a step that failed after exhausting its own retries.
- Both carry a **serializable** shape (message, name, optional cause, step/workflow
  identifiers) so they can be journaled and later flushed.
- **Extensible error serialization.** The default structural encoding `{ name, message,
stack?, cause? }` is lossy for rich domain errors — e.g. an `AxiosError` carrying `response`
  / `config`, or a `PrismaError` with a query code. Dropping those silently destroys debugging
  context on inspection and replay. The engine therefore exposes an error-serialization hook
  via `flowrun.configure({ serializeError, deserializeError })`, letting callers register
  customizers that preserve (codec-serializable) deep error context in the journal. The
  built-in encoder is the fallback when no customizer matches. Whatever a customizer emits must
  pass the §11.4 codec, keeping flush/resume sound.

### 9. Proposed module layout

The ADR is a design record, not the implementation, but the intended layout is:

| File            | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| `src/index.ts`  | Public API: `registerWorkflow`, `configure`, default export          |
| `src/engine.ts` | Executor / replay logic and retry orchestration                      |
| `src/store.ts`  | In-memory `Store` + the `Persistence` seam (flush/load scopes)       |
| `src/types.ts`  | Shared types: `WorkflowContext`, `StepContext`, `RunStatus`, options |
| `src/errors.ts` | Error classes                                                        |

### 10. Public API (target types)

```ts
declare const flowrun: {
	registerWorkflow<Args extends unknown[], Out>(
		name: string,
		handler: (config: WorkflowContext<Args>) => Promise<Out>,
	): Workflow<Args, Out>;

	configure(options: {
		serializeError?: (err: unknown) => SerializedError; // §8 error hook
		deserializeError?: (e: SerializedError) => unknown;
		// future: persistence backend, default backoff/retries
	}): void;
};

interface WorkflowContext<Args extends unknown[]> {
	args: Args;
	runId: string;
	step: {
		run<T>(name: string, fn: (s: StepContext) => Promise<T>, opts?: StepOptions): Promise<T>;
		sleep(name: string, ms: number): Promise<void>;
	};
}

// Passed to every step body so it can introspect its own execution.
interface StepContext {
	stepName: string;
	attempt: number; // 1-indexed current attempt of THIS step (see §11.7)
	runId: string;
	// future: signal/abort, logger, etc.
}

interface StepOptions {
	retries?: number;
	backoff?: BackoffStrategy;
}

interface Workflow<Args extends unknown[], Out> {
	run(input: { args: Args }, opts?: { retries?: number; backoff?: BackoffStrategy }): Promise<Out>;
}

export default flowrun;
```

`StepContext.attempt` is what lets a flaky step do localized logging or attempt-dependent
behavior (e.g. widen a timeout on later tries) without the workflow body observing
non-deterministic retry state.

This is type-compatible with the target snippet in the Context section.

---

## 11. Recommended data structures & algorithms

This section specifies the concrete data structures and algorithms recommended for the
implementation, together with their invariants and asymptotic costs. It is intentionally
formal: the correctness of a durable execution engine rests entirely on a small number of
invariants being maintained under retry and replay, so they are stated precisely.

### 11.1 Formal model and notation

Let a **workflow** be a deterministic effectful function

$$h : \text{Args} \times \mathcal{C} \rightarrow \text{Out}$$

where $\mathcal{C}$ is the execution context supplying `step.run` and `step.sleep`.
Determinism here is _relative to the journal_: every observable effect is mediated by a step,
so $h$ is a pure function of its arguments and the values returned by its steps.

A **run** is a tuple $r = (\mathit{id}, \mathit{name}, s, A, J)$ where $s$ is a status, $A$
the argument vector, and $J$ the **journal** — a finite partial map

$$J : \text{StepName} \rightharpoonup \text{StepEntry}.$$

Steps are identified by name, so $J$ is a _map keyed by name_, **not** a sequence keyed by
call order. This is the single most important representational choice in the design: it is
what makes partial replay, conditional branches, and parallel steps well-defined (§11.5,
§11.8).

**Memoization** is the act of treating $h$'s evaluation as a lookup in $J$: when $h$ calls
`step.run(n, f)`, the engine returns $J(n).\text{result}$ if $n \in \operatorname{dom}(J)$
with status `completed`, and otherwise evaluates $f$ and _extends_ $J$ at $n$.

### 11.2 Step lifecycle (state machine)

Each `StepEntry` is a node in a monotone state machine:

```
            run f                 f resolves
  (absent) ───────▶ running ───────────────▶ completed   (terminal-success)
                      │  ▲
              f rejects│  │ retry (attempts < limit)
                      ▼  │
                    failed ──────────────────────────────▶ (terminal-failure,
                       (attempts exhausted)                  surfaced to workflow)
```

**Invariant I1 (monotonicity).** A step entry never transitions out of a terminal state
`completed`. Once `J(n).status = completed`, all subsequent `step.run(n, …)` calls — within
this attempt or any retry — are pure reads. This is the memoization guarantee.

**Invariant I2 (single committed result).** For a given `(runId, name)` there is at most one
committed `result`. Concurrent (logically parallel) calls with the same name resolve to the
same committed value (§11.8, "first-writer-wins").

### 11.3 Primary data structures

| Structure                                 | Type                                               | Operations                | Cost                                            | Rationale                                                                                    |
| ----------------------------------------- | -------------------------------------------------- | ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Run table**                             | `Map<RunId, RunState>` (hash map)                  | get/put/delete by id      | $O(1)$ expected                                 | The authoritative RAM store; point access by `runId` dominates.                              |
| **Journal**                               | `Map<StepName, StepEntry>` (hash map), one per run | lookup/insert by name     | $O(1)$ expected                                 | Memoization lookup is the hot path; ordering is irrelevant because identity is by name (I1). |
| **In-flight set**                         | `Map<StepName, Promise<T>>` per run                | get/set/delete            | $O(1)$ expected                                 | De-duplicates concurrent calls to the same step name (§11.8).                                |
| **Timer queue**                           | binary min-heap keyed by `wakeAt`                  | push / peek-min / pop-min | push/pop $O(\log k)$, peek $O(1)$               | Scalable scheduling of `step.sleep` wakeups for a single shared scheduler (§11.6).           |
| **Status index** _(optional, for resume)_ | `Map<RunStatus, Set<RunId>>`                       | membership / iterate      | $O(1)$ insert, $O(\lvert\text{set}\rvert)$ scan | Lets resume enumerate `running` runs without scanning the whole table.                       |

**Why hash maps over ordered/array structures.** The journal is accessed by name with no
range or order semantics; a hash map gives expected $O(1)$ versus $O(\log n)$ for a balanced
BST or $O(n)$ for a linear scan of an array. The trade-off — loss of deterministic iteration
order — is irrelevant because replay never depends on journal iteration order (it depends on
the _handler's_ call order, which $h$ reproduces deterministically). If a deterministic
serialization order is desired for snapshots, sort keys at flush time in $O(m \log m)$ for a
run of $m$ steps, or use an insertion-ordered map (JavaScript `Map` already preserves
insertion order, which we exploit for stable snapshots at no extra cost).

**Run identifiers.** Use **UUIDv7** — a lexicographically sortable, time-ordered id — rather
than UUIDv4. Sortable ids (a) give natural creation-order iteration without a separate index,
and (b) map to efficient primary-key/clustered-index layouts in any future flushed backend,
avoiding random-insert B-tree fragmentation. Generation is $O(1)$.

### 11.4 Snapshot representation and serialization (three scopes)

The state is a tree `global ⊇ run ⊇ step`, so each scope is a sub-tree serialized in
isolation (§7). Serialization is a structural fold:

```
serialize(global)  = { runs:  [ serialize(run_i) for run_i in table ] }   // O(N + Σ m_i)
serialize(run)     = { run, steps: [ serialize(e_j) for e_j in journal ] } // O(m)
serialize(step)    = encode(entry)                                         // O(|value|)
```

with $N$ runs and $m_i$ steps in run $i$. Encoding visits each value once, so a `global`
flush is $O\!\left(N + \sum_i m_i + \sum \lvert\text{value}\rvert\right)$ — linear in total
state size; `run` flush is linear in one run; `step` flush is linear in one value.

Recommendations:

- **One codec is the single source of truth for the supported value set** (see §7). It must
  round-trip the extended types — `Date`, `Map`, `Set`, typed arrays, `BigInt` — to a
  backend-portable form (e.g. a tagged JSON envelope such as `{"$type":"Map","value":[…]}`,
  or a binary format) so the _same_ values that work against the in-memory store also survive
  a JSON-column SQL backend. Crucially, the engine must **not** lean on bare `structuredClone`
  as the contract: `structuredClone` would let native `Map`/`Set` flow through in v1 and then
  silently break under a JSON backend in v2. The codec defines what is legal; `structuredClone`
  is at most an _implementation detail_ of fast in-memory copying for types the codec already
  blesses. Values outside the codec (functions, symbols, class instances) are rejected eagerly
  at commit time.
- **Structural sharing for incremental flush.** Because terminal step entries are immutable
  (I1), a `step`-scoped flush need only re-encode the one changed entry; a `run`-scoped flush
  can skip entries whose content hash is unchanged. This turns the common case (one step
  completed) from $O(m)$ into $O(1)$ amortized writes.
- **Errors** are encoded structurally — `{ name, message, stack?, cause? }` — never as live
  `Error` objects, satisfying I-serializability for the error model (§8).

### 11.5 Replay / memoization algorithm

The core of `step.run`, executed for every step call on every attempt:

```
function stepRun(run, name, f, opts):
    e ← run.journal.get(name)
    if e ≠ ⊥ and e.status = completed:        # I1: memoized read
        return e.result                        # O(1), f NOT executed
    if name ∈ run.inflight:                    # logical concurrency dedup (§11.8)
        return await run.inflight[name]
    p ← runWithRetries(run, name, f, opts)     # §11.7
    run.inflight[name] ← p
    result ← await p
    run.inflight.delete(name)
    return result
```

**Invariant I3 (replay equivalence).** Let attempt $k$ produce committed journal $J_k$. Then
on attempt $k{+}1$, for every step call `step.run(n, …)` issued by $h$, if $n \in
\operatorname{dom}(J_k)$ as `completed`, the call is served in $O(1)$ from $J_k$ and $f$ is
not invoked. Consequently the _only_ steps that execute on a retry are those absent or
non-`completed` in $J_k$. **Proof sketch:** by determinism of $h$ relative to the journal,
the sequence of `(name, args-dependence)` it emits is a function of the returned step values;
inductively, each completed step returns the identical memoized value, so $h$ re-emits the
same calls until the first non-completed step, after which execution proceeds normally. ∎

**Cost.** A retry over a run with $m$ steps, of which $c$ are already completed, costs
$O(c)$ for the replayed reads plus the cost of executing the remaining $m-c$ steps. The
replay overhead is therefore linear and cache-friendly (pure map hits).

### 11.6 Durable sleep

`step.sleep(n, Δ)` is a step whose committed datum is an absolute wake time:

```
function stepSleep(run, name, Δ):
    e ← run.journal.get(name)
    if e = ⊥:
        e ← { status: completed?, wakeAt: now() + Δ }   # commit wakeAt once
        run.journal.set(name, e)
    remaining ← e.wakeAt − now()
    if remaining > 0:
        await schedule(e.wakeAt)        # timer min-heap, or setTimeout in v1
    # else: already elapsed → return immediately on replay
```

**Invariant I4 (idempotent deadline).** `wakeAt` is written exactly once; replays compute
`remaining = wakeAt − now()` against the _fixed_ deadline, so total wall-clock sleep across
any number of replays converges to the originally requested $\Delta$ (never resets). This is
what makes sleep durable rather than "restartable".

**Clock-skew hazard (cross-process resume).** I4 holds trivially within one process. Once a
run is flushed and resumed on a _different_ host, `wakeAt − Date.now()` is unsafe: a backward
clock skew of a few seconds can make an already-due sleep look pending (or vice-versa). The
engine therefore (a) reads time through a **clock abstraction** — a single injectable `now()`
the whole engine shares, never raw `Date.now()` scattered through call sites — and (b)
mandates that on `resume()`, deadline expiry is evaluated against the **persistence backend's
authoritative timestamp** captured at load time, not the resuming host's wall clock. Within a
process, a monotonic source (`performance.now()`-style) drives the relative wait so the timer
is immune to wall-clock adjustments; `wakeAt` remains an absolute wall-clock instant only for
the durable record and cross-process comparison against the authoritative time source.

**Scheduler.** v1 may use `setTimeout` per sleep ($O(1)$ per timer, but $O(k)$ live timers).
For many concurrent sleeps, prefer a **single min-heap timer wheel**: insert in $O(\log k)$,
and a single driver fires due entries via repeated peek-min/pop-min. This bounds OS timer
pressure and gives a clean, serializable schedule that survives flush/resume (the heap is
reconstructible from the `wakeAt` fields alone in $O(k)$ via `build-heap` — Floyd's
$O(k)$ heapify — on resume).

### 11.7 Retry with backoff (two levels)

Per-step and workflow-level retries share one routine parameterized by a backoff function
$b(i)$ giving the delay before attempt $i$ (1-indexed):

```
function runWithRetries(ctx, name, f, { retries, backoff }):
    attempt ← 0
    loop:
        attempt ← attempt + 1
        try:
            v ← await f(ctx)
            commit(name, completed, v)        # atomic journal write (I2)
            return v
        catch err:
            if attempt > retries:             # retries exhausted
                commit(name, failed, err)
                throw StepFailedError(name, err)
            await sleep(backoff(attempt))     # backoff before next attempt
```

**Backoff functions** (closed-form, $O(1)$):

| Strategy                  | $b(i)$                                                   | Notes                                                                                                   |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fixed                     | $d$                                                      | Constant delay.                                                                                         |
| Linear                    | $d \cdot i$                                              | Rarely optimal; included for completeness.                                                              |
| Exponential               | $d \cdot 2^{\,i-1}$, capped at $d_{\max}$                | Default for transient-failure backpressure.                                                             |
| Exponential + full jitter | $\text{Uniform}(0,\ \min(d_{\max},\ d \cdot 2^{\,i-1}))$ | **Recommended.** Decorrelates retries across concurrent runs, avoiding thundering-herd synchronization. |

**Precedence (§4) restated as composition.** The workflow-level loop wraps the handler; the
per-step loop wraps each `f`. A step exhausts its own retries first (inner loop) and surfaces
`StepFailedError`; that propagates out of $h$, the outer loop catches it, applies its backoff,
and re-enters $h$, which replays committed steps (I3) and resumes at the failed step. The two
loops are independent; total attempts for a given step are bounded by
$(\text{step.retries}+1)\times(\text{workflow.retries}+1)$ in the worst case.

### 11.8 Concurrency model and parallel steps

JavaScript's single-threaded event loop is leveraged deliberately: **journal mutations are
never preempted mid-statement**, so a committed write (I2) is atomic with respect to other
step callbacks without locks, mutexes, or CAS. "Concurrency" here is _logical_ — multiple
steps may be in-flight (awaiting I/O) simultaneously via `Promise.all`.

The hazard is two logically-concurrent calls to the _same_ step name (e.g. an accidental
duplicate inside two parallel branches). The **in-flight map** (§11.3) resolves this:

- The first call for `name` inserts its pending promise into `inflight[name]`.
- A second concurrent call for the same `name` observes the entry and `await`s the _same_
  promise rather than launching a second execution.

This yields **first-writer-wins** and upholds I2: at most one execution of `f`, one committed
result, shared by all callers. Without the in-flight map, parallel duplicate names would race
to commit, risking two executions of a side-effecting step. Lookup/insert are $O(1)$.

For genuinely parallel _distinct_ steps, `Promise.all([...])` simply produces several
in-flight entries; each commits independently, and replay (I3) restores all of them on a
later attempt regardless of original completion order.

**Invariant I5 (in-flight is attempt-scoped, not run-scoped).** The in-flight map must be
**cleared at the start of every workflow attempt** — a pending or rejected promise must never
survive across a workflow-level retry boundary. Consider the hazard: branch A and branch B
both await one promise for a duplicate step name; the underlying work fails, exhausts its
step retries, commits `failed`, and rejects; the rejection propagates out of $h$ and triggers
a workflow-level retry. If attempt $k{+}1$ re-enters $h$ and observes the **stale rejected
promise** from attempt $k$ still in the map, it would instantly re-fail (or read torn state)
instead of cleanly re-executing. The rule is therefore explicit: each attempt begins with an
empty in-flight map; only the **journal** (committed, terminal entries) crosses attempt
boundaries. Promises are ephemeral execution state and are discarded between attempts; the
journal is durable state and is not. Note that a step committed `failed` by I1 is _not_
terminal in the memoization sense (only `completed` is — see I1), so on the retry it is
eligible to run again, served fresh rather than from a dead promise.

### 11.9 Execution & delivery semantics

- **Within a single process (pure RAM):** because `commit` precedes the return of `step.run`
  and is atomic (§11.8), each step executes **exactly once** per run — even across
  workflow-level retries, by I3.
- **Across flush/resume:** semantics depend on _when_ flush occurs relative to `commit`. If
  the engine flushes the step scope immediately after each `commit`, a resume after a crash
  observes all committed steps and re-executes only the in-flight (uncommitted) one →
  **at-least-once** for the interrupted step, exactly-once for committed steps. If flush is
  coarser (run/global, periodic), more steps may re-execute on resume. **Implication for
  authors:** steps that have external side effects should be idempotent, or carry an
  idempotency key, so at-least-once re-execution is safe. This is the standard durable-engine
  contract and should be documented prominently.

### 11.10 Memory management & retention

The run table grows monotonically unless pruned. Recommended policy:

- **Eviction on terminal state.** After a run reaches `completed`/`failed` _and_ (if enabled)
  has been flushed, evict it from the run table — $O(1)$ delete — to bound RAM. Optionally
  keep a small LRU of recent runs for inspection.
- **Result size discipline.** Step results live in RAM for the run's lifetime and are
  duplicated on flush; large blobs should be stored by reference (a handle returned from a
  step) rather than inlined into the journal.
- **Bounded journals.** Because identity is by name, a workflow that generates _unbounded_
  distinct step names (e.g. names derived from a loop counter over an unbounded stream) will
  grow $J$ without bound; document that step names should be drawn from a bounded set, or that
  such workflows must be chunked/continued.

**Long-lived runs are a v1 limitation (explicit).** Because RAM is authoritative and v1 has
no resume, an _in-flight_ run occupies RAM for its entire lifetime — including time parked in
`step.sleep`. A workflow that sleeps for 30 days, or polls indefinitely, pins memory the whole
time; tens of thousands of such instances will exhaust the process. **v1 is therefore
optimized for high-throughput, short-to-medium-lived runs**, and this is stated as a known
boundary, not a defect. The architecture already anticipates the fix: once flush/resume lands,
`step.sleep` gains a **passivation** path — on encountering a sufficiently distant `wakeAt`,
the engine flushes the run, evicts it from RAM, and hands the `wakeAt` to an external
scheduler that calls `resume()` at the deadline. The durable record needed for this (`wakeAt`
plus the committed journal) already exists in the §7 model, so passivation is additive and
requires no workflow-API change.

### 11.11 Complexity summary

For a run with $m$ steps, $c$ already completed, $k$ live sleeps, and $N$ total runs:

| Operation                    | Time                                   | Space                          |
| ---------------------------- | -------------------------------------- | ------------------------------ |
| `step.run` memoized hit      | $O(1)$ expected                        | —                              |
| `step.run` first execution   | $O(1)$ + cost of `f`                   | $O(\lvert\text{result}\rvert)$ |
| Full replay of an attempt    | $O(c)$ + cost of remaining $m-c$ steps | —                              |
| `step.sleep` schedule (heap) | $O(\log k)$                            | $O(k)$                         |
| Run lookup / create / evict  | $O(1)$ expected                        | $O(m)$ per run                 |
| Flush `step` (incremental)   | $O(1)$ amortized                       | $O(\lvert\text{value}\rvert)$  |
| Flush `run`                  | $O(m)$                                 | $O(m)$                         |
| Flush `global`               | $O\!\left(N + \sum_i m_i\right)$       | proportional                   |
| Resume (rebuild heap)        | $O(k)$ heapify + load cost             | $O(N + \sum m_i)$              |

---

## Consequences

**Positive**

- True durable execution: completed steps are memoized and replayed across retries within a
  process.
- A clean path to cross-process / cross-restart durability via flush-and-resume, added later
  without touching the workflow API.
- Flush granularity (step / run / global) gives callers fine control over the durability vs.
  overhead trade-off.
- Parallel steps and durable sleep work with ordinary JavaScript control flow.

**Negative / costs**

- Workflow authors must follow the **determinism contract** — all non-determinism must live
  inside steps. This is unenforced in v1 and is the main footgun.
- **Codec-serializability is mandatory** for step values, run state, and errors (§11.4) —
  enforced eagerly at commit time. Values outside the codec (functions, symbols, class
  instances) are rejected.
- In-memory-only v1 means state is lost on process exit until flush/resume lands, and
  **long-lived/parked runs pin RAM for their full lifetime** (§11.10) — v1 targets
  short-to-medium-lived runs; passivation arrives with flush/resume.

---

## Alternatives considered

- **Event-sourced journal** (append-only event log, fold to derive state — Temporal-style).
  More flexible and audit-friendly, but heavier to implement and serialize for a RAM-first
  model. Rejected for v1 in favor of snapshot-per-step; may be revisited.
- **Swappable per-operation store backend** (read/write a DB on every step). Rejected: it
  contradicts the RAM-first constraint and adds latency to every step.
- **Re-run the whole workflow on failure with no memoization.** Simplest, but not durable —
  defeats the purpose of the library.
- **Positional step keying** (by call index instead of name). Rejected: breaks under parallel
  steps and conditional branches; name-keying is required.

---

## Future considerations (out of scope for v1, but the architecture must accommodate)

- `flush` / `load` / `resume` to a durable backend (DB, file, object store) and resuming
  in-flight runs in a new process.
- Signals & external events (workflow suspension/resumption awaiting input).
- Scheduling / cron triggers.
- Cancellation & timeouts.
- Observability / run-history inspection APIs.
- Workflow versioning (handling code changes for long-lived runs).
- Dev-mode determinism checks (duplicate/unstable step-name detection).
