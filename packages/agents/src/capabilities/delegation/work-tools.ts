import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import { tryGetDelegationRuntime } from "./runtime.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

/**
 * The Speaker pull tool (S3): read the full progress of one background work item beyond the
 * one-line milestone the digest already carries — every streamed Milestone in order, plus the
 * terminal outcome once the work has finished. Read-only; the Speaker never launches or mutates
 * work. `found: false` when delegation is unwired or the id is unknown, so it never throws a turn.
 *
 * Scoped to the calling Speaker's chat (`id` = its managed chat id), mirroring the digest guard:
 * a work item is visible only when its source Surface resolves to this chat via
 * `providerChatIdForSurface`. A workId from another chat reads as `found: false`, never leaking.
 */
export const createLookupWorkTool = (chatId: string): ToolDefinition =>
  defineTool({
    name: "lookup_work",
    description:
      "Read one background work item by its work id (from the digest's workItems): every streamed milestone in " +
      "order and the terminal outcome if it has finished. Use it to report on work in flight; you never start or " +
      "change work yourself.",
    input: v.object({ workId: nonEmpty }),
    output: v.object({
      found: v.boolean(),
      specialist: v.optional(v.string()),
      status: v.picklist(["active", "ok", "interrupted", "unknown"]),
      milestones: v.array(v.object({ note: v.string(), at: v.string() })),
      result: v.optional(v.unknown()),
    }),
    run: ({ input }) => {
      const runtime = tryGetDelegationRuntime();
      const absent = { found: false, status: "unknown" as const, milestones: [] };
      if (runtime === undefined) return absent;
      const launch = runtime.inbox.specialistLaunch(input.workId);
      if (launch === undefined) return absent;
      // Fail-closed cross-surface guard: only this chat's own work is readable here.
      if (runtime.providerChatIdForSurface(launch.sourceSurfaceId) !== chatId) return absent;
      const milestones = runtime.inbox.workMilestones(input.workId).map((milestone) => ({
        note: milestone.note,
        at: milestone.at,
      }));
      const result = runtime.inbox.specialistResultForWork(input.workId);
      return {
        found: true,
        specialist: launch.specialist,
        status: result === undefined ? ("active" as const) : result.status,
        milestones,
        ...(result?.result === undefined ? {} : { result: result.result }),
      };
    },
  });
