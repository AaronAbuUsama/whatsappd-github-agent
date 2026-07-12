import { Duration, Effect, type Scope } from "effect";
import { Client, type SessionState } from "eve/client";
import { githubResultSchema, type GithubResult } from "../../agent/subagents/github/lib/output-schema.ts";
import type { DelegationJob, GatewayStore } from "../../agent/lib/jobs.ts";
import { harvestSays } from "../coalescer/doorway.ts";

export interface JobLoopback {
  readonly runGithub: (job: DelegationJob) => Promise<GithubResult>;
  readonly deliverVoice: (job: DelegationJob, state: SessionState, message: string) => Promise<SessionState>;
}

/** Production adapter: every direction uses the same eve/client loopback doorway. */
export const eveJobLoopback = (
  client: Client,
  reply: (chatId: string, text: string) => Promise<void>,
): JobLoopback => ({
  runGithub: async (job) => {
    const session = client.session();
    const response = await session.send<GithubResult>({
      message:
        "This is a detached gateway job, not a WhatsApp voice turn. Call the declared `github` " +
        "subagent exactly once with the task below and its structured output schema. Return that " +
        `typed worker result as your own final result. Do not call say.\n\nTask:\n${job.task}`,
      outputSchema: githubResultSchema,
    });
    const result = await response.result();
    if (result.status === "failed") throw new Error(`GitHub worker session failed for job ${job.id}`);
    const delegated = result.events.some(
      (event) => event.type === "subagent.called" && event.data.name === "github",
    );
    if (!delegated) throw new Error(`Detached worker did not call the github subagent for job ${job.id}`);
    return githubResultSchema.parse(result.data);
  },
  deliverVoice: async (job, state, message) => {
    if (job.chatId === undefined) throw new Error(`Claimed job ${job.id} has no chatId`);
    // Critical correction: resume from the full persisted state, never chatId/token alone.
    const session = client.session(state);
    const response = await session.send({ message });
    const result = await response.result();
    if (result.status === "failed") throw new Error(`Voice report-back failed for job ${job.id}`);
    const says = harvestSays(result.events);
    if (says.length === 0) throw new Error(`Voice did not narrate report-back for job ${job.id}`);
    for (const text of says) await reply(job.chatId, text);
    return session.state;
  },
});

const errorText = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "cause" in cause && cause.cause !== undefined) {
    return errorText(cause.cause);
  }
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
};

const successTurn = (job: DelegationJob, result: GithubResult): string => {
  const reference = [result.number === undefined ? undefined : `#${result.number}`, result.url]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return (
    `[worker result for job ${job.id}] ${reference}\n` +
    `${JSON.stringify(result)}\n` +
    "This is the completed delegated result. Narrate it to the group now with say; include the real number and URL when present."
  );
};

const failureTurn = (job: DelegationJob, error: string): string =>
  `[worker FAILED job ${job.id}] ${error}\nNarrate this failure to the group now with say; do not silently drop it.`;

const deliver = (
  store: GatewayStore,
  loopback: JobLoopback,
  job: DelegationJob,
  message: string,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise(() => {
    if (job.chatId === undefined) throw new Error(`Claimed job ${job.id} has no chatId`);
    return store.runExclusive(job.chatId, async () => {
      const state = store.get(job.chatId!);
      if (state === undefined) throw new Error(`Voice session state missing for ${job.chatId}`);
      const nextState = await loopback.deliverVoice(job, state, message);
      store.set(job.chatId!, nextState);
    });
  });

const report = (store: GatewayStore, loopback: JobLoopback, job: DelegationJob): Effect.Effect<void> => {
  const succeeded = job.result !== undefined;
  const message = succeeded
    ? successTurn(job, job.result!)
    : failureTurn(job, job.error ?? "Worker failed without an error message");
  return deliver(store, loopback, job, message).pipe(
    Effect.tap(() => Effect.sync(() => (succeeded ? store.complete(job.id) : store.fail(job.id)))),
    Effect.catchAll((cause) =>
      Effect.sync(() => store.deferReport(job.id, `report-back failed: ${errorText(cause)}`)),
    ),
  );
};

const runWorker = (store: GatewayStore, loopback: JobLoopback, job: DelegationJob): Effect.Effect<void> =>
  Effect.tryPromise(() => loopback.runGithub(job)).pipe(
    Effect.matchEffect({
      onSuccess: (result) => {
        store.queueResult(job.id, result);
        return report(store, loopback, { ...job, status: "report_pending", result, error: undefined });
      },
      onFailure: (cause) => {
        const error = errorText(cause);
        store.queueFailure(job.id, error);
        return report(store, loopback, { ...job, status: "report_pending", result: undefined, error });
      },
    }),
  );

/** Claim one batch and supervise each job on its own scoped fiber. */
export const forkPendingJobs = (
  store: GatewayStore,
  loopback: JobLoopback,
  limit = 10,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const jobs = store.claimPending(limit);
    for (const job of jobs) {
      yield* Effect.forkScoped(job.status === "reporting" ? report(store, loopback, job) : runWorker(store, loopback, job));
    }
    return jobs.length;
  });

/** Long-lived gateway watcher. Forking means one slow worker never stalls claims or another worker. */
export const jobRunner = (
  store: GatewayStore,
  loopback: JobLoopback,
  options: { readonly batchSize?: number; readonly pollInterval?: Duration.DurationInput } = {},
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.forever(
    forkPendingJobs(store, loopback, options.batchSize ?? 10).pipe(
      Effect.zipRight(Effect.sleep(options.pollInterval ?? "1 second")),
    ),
  );
