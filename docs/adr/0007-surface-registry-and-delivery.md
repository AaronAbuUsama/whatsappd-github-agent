# Stable Surfaces replace chat-bound routing

A Surface has application-owned UUID identity, one continuing Speaker keyed by that UUID,
and one active account-scoped WhatsApp binding. Provider discovery feeds the Conversation
Archive but never authorizes participation. Every configured chat seeds the same kind of active
Surface, regardless of whether WhatsApp labels it group or direct. `prompt_speaker` accepts an
existing `surfaceId` only. Provider kind may remain adapter metadata for envelope mechanics, but
it never selects a domain type, authorization rule, target-resolution path, or lifecycle. The
model never supplies a raw JID.

Every intake and Say resolves and revalidates the current binding. Re-pairing the same account
preserves Surface identity; pairing a different account retires old bindings without silent
rebinding. Intent's source Surface remains provenance rather than a forced return address.

Each logical Say records a stable Surface Delivery before `session.send`. Provider
acknowledgment and the outbound Conversation Archive event prove sent; known rejection is
failed; ambiguity is Uncertain and is not retried blindly. Directive Outcomes return that
durable result to the Brain.

## Rejected

- Provider chat JID as Surface/Speaker identity.
- Discovery as authorization.
- Any group/direct distinction in the Surface model or Brain contract.
- A Person target, `brain_opened` Surface kind, or `open_surface` Brain effect.
- A generic channel platform abstraction before a second provider exists.
- Logs or generated Flue ids as delivery truth.
