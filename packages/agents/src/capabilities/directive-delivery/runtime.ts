import type { DirectiveOutcome, SurfaceDeliveryStore } from "@ambient-agent/engine/surfaces/delivery.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

import { getWhatsAppParticipationPort } from "../whatsapp-participation/whatsapp-port.ts";

export interface DirectiveDeliveryRuntime {
  readonly deliveries: SurfaceDeliveryStore;
}

const runtime = createFlueGlobal<DirectiveDeliveryRuntime>(
  "directive-delivery-runtime",
  "The Directive Delivery runtime is not configured.",
);

export const configureDirectiveDeliveryRuntime = (value: DirectiveDeliveryRuntime): void => runtime.set(value);

export const deliverDirective = async (
  speakerId: string,
  directiveId: string,
  text: string,
): Promise<DirectiveOutcome> => {
  const deliveries = runtime.get().deliveries;
  const claim = deliveries.claim(directiveId, speakerId, text);
  if (claim.kind === "settled") return claim.outcome;
  try {
    const result = await getWhatsAppParticipationPort().say(speakerId, text);
    return deliveries.settle(claim.delivery.id, result);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return deliveries.settle(claim.delivery.id, {
      delivery: "unknown",
      deliveryError: `WhatsApp transport threw before its outcome could be proven: ${error}`,
    });
  }
};
