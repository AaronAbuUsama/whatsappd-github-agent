import { createFlueClient } from "@flue/sdk";
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import scribe from "@ambient-agent/agents/scribe/agent.ts";
import { scribeDirectBaseUrl, scribeDirectToken } from "@ambient-agent/agents/scribe/direct-access.ts";
import { scribeBatchInput } from "@ambient-agent/agents/scribe/input.ts";
import { createScribeBackfillStore } from "@ambient-agent/engine/intake/scribe-backfill.ts";
import { getManagedRuntimeDependencies } from "@ambient-agent/installation/runtime-dependencies.ts";

const input = v.object({ chatId: v.pipe(v.string(), v.minLength(1)) });
const output = v.object({
  outcome: v.picklist(["live", "failed", "disabled"]),
  chatId: v.string(),
  windowsProcessed: v.optional(v.number()),
  eventsProcessed: v.optional(v.number()),
  finalSequence: v.number(),
  errorCode: v.optional(v.string()),
});

const run = async ({ input: { chatId }, log }: { input: v.InferOutput<typeof input>; log: { info(message: string, attributes?: object): void; warn(message: string, attributes?: object): void; error(message: string, attributes?: object): void } }) => {
  const dependencies = getManagedRuntimeDependencies();
  const store = createScribeBackfillStore(dependencies.paths.applicationDatabase);
  const client = createFlueClient({ baseUrl: scribeDirectBaseUrl(dependencies.configuration.runtime.port), token: scribeDirectToken() });
  let windowsProcessed = 0;
  let eventsProcessed = 0;
  try {
    store.captureSnapshot(chatId);
    log.info("scribe_backfill.started", { chatId, phase: store.get(chatId)?.phase ?? "snapshot", startingSequence: store.get(chatId)?.afterSequence ?? 0 });
    for (;;) {
      const state = store.get(chatId);
      if (state?.mode === "disabled") return { outcome: "disabled" as const, chatId, finalSequence: state.afterSequence };
      const page = store.nextPage(chatId);
      if (page === undefined) {
        if (store.handoff(chatId)) {
          const finalSequence = store.get(chatId)?.afterSequence ?? 0;
          log.info("scribe_backfill.live", { chatId, windowsProcessed, eventsProcessed, finalSequence });
          return { outcome: "live" as const, chatId, windowsProcessed, eventsProcessed, finalSequence };
        }
        continue;
      }
      if (page.input === undefined) {
        store.checkpoint(chatId, page);
        log.info("scribe_backfill.window.skipped", { chatId, phase: state?.phase, throughSequence: page.throughSequence, receiptCount: page.receiptCount });
        continue;
      }
      log.info("scribe_backfill.window.started", { chatId, phase: state?.phase, window: windowsProcessed + 1, throughSequence: page.throughSequence, archiveEventCount: page.archiveEventCount, scribeEventCount: page.archiveEventCount - page.receiptCount, receiptCount: page.receiptCount });
      let failure: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await client.agents.prompt("scribe", chatId, { message: JSON.stringify(scribeBatchInput([page.input])) });
          failure = undefined;
          break;
        } catch (cause) {
          failure = cause;
          if (attempt < 3) log.warn("scribe_backfill.window.retrying", { chatId, window: windowsProcessed + 1, attempt: attempt + 1, errorCode: "scribe_prompt_failed" });
        }
      }
      if (failure !== undefined) {
        store.fail(chatId, "scribe_prompt_failed");
        log.error("scribe_backfill.failed", { chatId, window: windowsProcessed + 1, attempts: 3, errorCode: "scribe_prompt_failed" });
        return { outcome: "failed" as const, chatId, finalSequence: state?.afterSequence ?? 0, errorCode: "scribe_prompt_failed" };
      }
      store.checkpoint(chatId, page);
      windowsProcessed++;
      eventsProcessed += page.archiveEventCount - page.receiptCount;
      log.info("scribe_backfill.window.completed", { chatId, phase: state?.phase, window: windowsProcessed, throughSequence: page.throughSequence, eventsProcessed });
    }
  } finally {
    store.close();
  }
};

export default defineWorkflow({ agent: scribe, input, output, run });
