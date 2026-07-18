import assert from "node:assert/strict";
import { decision, flowOptions, persistence, rubricCriteria, runtimeBootProfiles, screens, transitions } from "./model.mjs";

const requiredScreens = ["account", "subscription", "coworker", "preparing", "model", "whatsapp", "chats", "github", "activation", "operate"];
const requiredFields = ["persistedState", "operations", "bridge", "errors", "visible", "tickets"];
const screenIds = screens.map(({ id }) => id);

assert.deepEqual([...new Set(screenIds)], screenIds, "screen ids must be unique");
for (const id of requiredScreens) assert(screenIds.includes(id), `missing required screen: ${id}`);

for (const screen of screens) {
  assert(screen.route.startsWith("/"), `${screen.id} must name a route`);
  for (const field of requiredFields) {
    assert(Array.isArray(screen[field]) && screen[field].length > 0, `${screen.id}.${field} must be non-empty`);
  }
  for (const ticket of screen.tickets) {
    assert(ticket.label && ticket.url, `${screen.id} has an incomplete ticket reference`);
  }
}

assert.equal(rubricCriteria.length, 6, "the required six-factor rubric must remain complete");
assert(flowOptions.length >= 3, "at least three product-flow options are required");
assert.equal(flowOptions.filter(({ recommended }) => recommended).length, 1, "exactly one option must be recommended");

for (const option of flowOptions) {
  assert(option.usage && option.hides && option.interfaceSketch, `${option.id} must show usage, hidden complexity, and code`);
  for (const criterion of rubricCriteria) {
    const score = option.scores[criterion.id];
    assert(Number.isInteger(score) && score >= 1 && score <= 5, `${option.id}.${criterion.id} must score 1-5`);
  }
}

assert.equal(decision.recommendation, flowOptions.find(({ recommended }) => recommended).id, "decision must point at recommended option");
assert.deepEqual(runtimeBootProfiles.map(({ mode }) => mode), ["setup", "operate"], "one image must expose only setup and operate profiles");
assert.equal(transitions[0].from, "account");
assert(transitions.some(({ from, to, event }) => from === "activation" && to === "operate" && event === "operate.healthy"));

const whatsappRepairTransitions = transitions.filter(({ event }) => event.startsWith("whatsapp.repair."));
assert.deepEqual(
  whatsappRepairTransitions.map(({ event }) => event),
  ["whatsapp.repair.started", "whatsapp.repair.completed"],
  "repair must model both entry and completion",
);
assert(
  whatsappRepairTransitions.every(({ from, to }) => from === "operate" && to === "operate"),
  "WhatsApp repair must return to operate without replaying onboarding",
);

const durableState = JSON.stringify(persistence).toLowerCase();
assert(!durableState.includes("pairing code"), "pairing code must never be durable state");
assert(!durableState.includes(" qr"), "QR material must never be durable state");
assert(persistence.tenantDatabase.some((entry) => entry.includes("#167/#182")), "tenant secret boundary must stay linked to T-B/storage tickets");

console.log(`T-G prototype contract valid: ${screens.length} screens, ${transitions.length} transitions, ${flowOptions.length} graded options.`);
