# Coalescing is lossless

> Amended by [ADR 0014](./0014-window-delivery-is-an-at-least-once-wake.md): every accepted live message still belongs to exactly one Window, but a Window's dispatch is at-least-once and may terminally fail.

Every accepted live message appears in exactly one Window admitted to Ambience. The Coalescer may delay messages until the chat settles, flush after a maximum wait, flush immediately when Ambience is addressed, or segment traffic when a Window reaches capacity, but it never evicts an unadmitted message by count or age; persisted history is memory, not a recovery mechanism for dropped input.
