# Stable Surfaces replace chat-bound routing

A Surface has application-owned UUID identity, one continuing Speaker keyed by that UUID,
and one active account-scoped WhatsApp binding. Provider discovery feeds the Conversation
Archive but never authorizes participation. Existing configured groups seed active Surfaces;
`prompt_speaker` accepts either an existing Surface or a known Person. Trusted application code
resolves a Person to an existing direct Surface or atomically materializes an ordinary direct
Surface inside the same prompt admission. There is no separate open-surface effect, Surface
kind, registry, or lifecycle. The model never supplies a raw JID.

Every intake and Say resolves and revalidates the current binding. Re-pairing the same account
preserves Surface identity; pairing a different account retires old bindings without silent
rebinding. Intent's source Surface remains provenance rather than a forced return address.

Each logical Say records a stable Surface Delivery before `session.send`. Provider
acknowledgment and the outbound Conversation Archive event prove sent; known rejection is
failed; ambiguity is Uncertain and is not retried blindly. Directive Outcomes return that
durable result to the Brain.

## Rejected

- Provider chat JID as Surface/Speaker identity.
- Discovery as authorization or model-created groups.
- `brain_opened` as a Surface kind, or `open_surface` as a standalone Brain effect.
- A generic channel platform abstraction before a second provider exists.
- Logs or generated Flue ids as delivery truth.
