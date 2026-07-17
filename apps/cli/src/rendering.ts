import type { InstallationInspection } from "@ambient-agent/core/managed/installation.ts";
import type { ManagedCheck } from "@ambient-agent/core/managed/diagnostics.ts";
import type { AmbientRuntimeHealth } from "@ambient-agent/core/managed/runtime-health.ts";
import type {
  UncertainActionResult,
  UncertainDoctorReport,
  UncertainWorkStatus,
} from "@ambient-agent/core/managed/uncertain-work.ts";
import type { ChatGptAuthenticationStatus } from "@ambient-agent/core/model/chatgpt-authentication.ts";
import type { ChatGptReadinessReceipt } from "@ambient-agent/core/model/pi-subscription.ts";

export interface WindowDeliveryCounts {
  readonly pending: number;
  readonly failed: number;
}

export interface InspectionReport {
  readonly installation: InstallationInspection;
  readonly authentication: ChatGptAuthenticationStatus;
  readonly checks: readonly ManagedCheck[];
  readonly observedRuntime?: AmbientRuntimeHealth;
  readonly liveCheck?: ChatGptReadinessReceipt;
  readonly uncertainWork?: UncertainWorkStatus;
  readonly windowDeliveries?: WindowDeliveryCounts;
  readonly uncertainDoctor?: UncertainDoctorReport;
  readonly uncertainAction?: UncertainActionResult;
}

/** Component roll-up of the internal five-state detail (#91): refreshable is machine-repairable, so ready. */
const chatGptComponentState = (authentication: ChatGptAuthenticationStatus): "ready" | "reauthentication-required" =>
  authentication.state === "ready" || authentication.state === "expired-refreshable"
    ? "ready"
    : "reauthentication-required";

export const renderInspection = (report: InspectionReport, json: boolean): string => {
  const {
    installation,
    authentication,
    checks,
    observedRuntime,
    liveCheck,
    uncertainWork,
    windowDeliveries,
    uncertainDoctor,
    uncertainAction,
  } = report;
  if (json)
    return `${JSON.stringify(
      {
        ...installation,
        checks,
        observedRuntime,
        ...(installation.state === "ready" ? { chatgpt: chatGptComponentState(authentication) } : {}),
        modelAuthentication: authentication,
        liveCheck,
        uncertainWork,
        windowDeliveries,
        uncertainDoctor,
        uncertainAction,
      },
      null,
      2,
    )}\n`;
  const lines = [`Ambient Agent: ${installation.state}`, `Data directory: ${installation.dataDirectory}`];
  for (const item of installation.diagnostics) {
    lines.push(`[${item.code}] ${item.message}`, `  Path: ${item.path}`, `  Fix: ${item.remediation}`);
  }
  for (const check of checks) {
    lines.push(`${check.name}: ${check.state} (${check.code})`, `  ${check.message}`);
    if (check.remediation !== undefined) lines.push(`  Fix: ${check.remediation}`);
  }
  if (installation.state === "ready") lines.push(`chatgpt: ${chatGptComponentState(authentication)}`);
  lines.push(`ChatGPT authentication: ${authentication.state}`);
  if (authentication.state === "missing") {
    lines.push(
      installation.state === "absent"
        ? "  Fix: Run ambient-agent init."
        : "  Fix: Run ambient-agent auth to authenticate again.",
    );
  }
  if (authentication.state === "malformed")
    lines.push(`  ${authentication.message}`, "  Fix: Run ambient-agent auth to authenticate again.");
  if (authentication.state === "expired-refreshable") {
    lines.push("  Fix: Run ambient-agent doctor --refresh to rotate the managed credential.");
  }
  if (authentication.state === "unusable")
    lines.push(
      `  ${authentication.message}`,
      installation.state === "incomplete" || installation.state === "corrupt"
        ? "  Fix: Run ambient-agent doctor and repair the managed installation."
        : "  Fix: Run ambient-agent auth to authenticate again.",
    );
  if (observedRuntime !== undefined) {
    lines.push(`Runtime: ${observedRuntime.state} (whatsapp ${observedRuntime.whatsapp.phase})`);
  }
  if (liveCheck !== undefined) {
    lines.push(
      `ChatGPT live readiness: ${liveCheck.request}${liveCheck.reason === undefined ? "" : ` (${liveCheck.reason})`}`,
    );
  }
  if (uncertainWork !== undefined) {
    lines.push(`Uncertain work: ${uncertainWork.health} (${uncertainWork.externalMutations} external mutations)`);
    if (uncertainWork.total > 0) {
      lines.push("  Fix: Run ambient-agent doctor, then choose --retry, --accept-observed, or --abandon explicitly.");
    }
  }
  if (windowDeliveries !== undefined) {
    lines.push(`backlog: ${windowDeliveries.pending} pending, ${windowDeliveries.failed} failed`);
  }
  if (uncertainDoctor !== undefined) {
    for (const item of uncertainDoctor.diagnoses) {
      lines.push(`  [${item.outcome}] ${item.ref}: ${item.evidence}`);
    }
    if (uncertainDoctor.deferred > 0) {
      lines.push(`  ${uncertainDoctor.deferred} additional Uncertain items were deferred to the next doctor run.`);
    }
  }
  if (uncertainAction !== undefined) {
    lines.push(
      `Uncertain action: ${uncertainAction.ref} -> ${uncertainAction.outcome}${
        uncertainAction.replacementRef === undefined ? "" : ` (${uncertainAction.replacementRef})`
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
};
