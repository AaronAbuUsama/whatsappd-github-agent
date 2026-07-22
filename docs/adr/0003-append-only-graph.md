# The Graph is append-only evidence plus a derived belief projection

The Graph persists immutable Attestations of the form
`{author, claim, confidence, evidenceSet, timestamp}`. Scribe attempts and deterministic
ingesters append observations; the Brain appends confirm, overrule, and merge rulings. No
author rewrites another author's claim or provenance.

The current ontology is a deterministic Belief Projection folded from that log. Digest and
Brain reads use the projection, never the raw Attestation log. Raw providers remain truth and
the projection remains rebuildable.

## Rejected

- Mutable entity/relation upserts, because they erase earlier belief and provenance.
- A separate proposed-versus-approved store, because authorship already distinguishes proposals from rulings.
- Making the Brain the sole writer, because proposal extraction must remain off its decision clock.
