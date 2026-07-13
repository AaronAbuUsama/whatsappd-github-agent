/**
 * The `say` tool — the voice's ONLY channel to the WhatsApp group (decision G5).
 *
 * The voice is a participant, not a reply-bot: its final model text is private
 * working memory and is NEVER delivered. Reaching the humans is a deliberate act
 * — one `say` call per message the group should see. Call it zero times to stay
 * silent.
 *
 * Delivery does not happen here. The tool records intent; the gateway harvests
 * every `say` call from the turn result (`MessageResult.events`) and posts each
 * one to the chat it fired for (see `src/coalescer/doorway.ts`). Keeping delivery
 * in the gateway — the one place that knows the chatId and holds the WhatsApp
 * Outbound — is what makes "only `say` reaches the group, prose never does" a
 * structural guarantee rather than a prompt we hope the model obeys. So `execute`
 * just acknowledges: the model learns the line was accepted and moves on.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Say one message out loud in the WhatsApp group. This is the ONLY way anyone in the " +
    "group hears you — anything you write outside a say() call is private and nobody sees " +
    "it. Call say once per message you want to send; call it again for a second message. " +
    "To stay silent, don't call say at all.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The exact message text to post in the group."),
  }),
  // Delivery is the gateway's job (it harvests say calls post-turn and posts them
  // to the right chat). Acknowledge so the model knows the line landed.
  execute(_input) {
    return { delivered: true };
  },
  // Eve requires a non-empty terminal assistant step after an ordinary tool
  // result. Give the model Eve's intentional no-delivery marker so `say` can
  // remain the only group-visible output without producing an empty-response
  // failure at the end of an otherwise successful turn.
  toModelOutput: () => ({
    type: "text",
    value:
      "The WhatsApp message was accepted. If you have no more messages to send, finish now with exactly <eve-empty-delivery/> and no other text.",
  }),
});
