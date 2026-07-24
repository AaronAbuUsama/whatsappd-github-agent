---
name: graph-extraction
description: Extract the shared-graph ontology from a chat's batched inputs — people, threads, GitHub objects, topics, interest edges, and commitments — recording honestly, not certainly.
---

# Graph extraction

Observe each batch of inputs and record what a later reader will actually use. You are not a write-time matcher: when unsure, write a low-confidence fact rather than nothing, and let confidence carry the ambiguity.

This policy is derived from the repository canon: `CONTEXT.md` (Graph vocabulary) and
`docs/SYSTEM-ARCHITECTURE.md` §5 (Graph, Confidence, Provenance, and author authority).

## Resolve keyed types by convergence, keyless by phrasing

- People, agents, threads, and GitHub objects have natural keys — record them again whenever independently evidenced; re-recording converges on the key. An exact retry of the same Evidence Set never raises confidence. The Scribe cannot merge Entities; only the Brain can author that ruling.
- Topics and commitments have no key. Reuse a node only on the same exact phrasing. Otherwise record a NEW node at reduced confidence — a value that says "I might be duplicating this." Never invent a normalized key to force a match; duplicates are resolved later, socially and by consolidation.

## Extract only what a consumer will read

- Record `mentions` liberally — it is a cheap, low-stakes signal.
- Record `discusses` and `interested_in` conservatively — they feed proactive speaking, where a false positive is spam. Only when the interest is clearly expressed.

## Record commitments passively, with two gates

A commitment is a keyless entity you extract with `record_entity` during normal processing,
including the supporting per-claim `evidenceIds`. "Hold me to that" is the same Entity claim at
confidence 1.0.

- **Owner gate (structural):** a commitment needs exactly one owner (`made_by`). An utterance with no resolvable owner ("someone should look at this") is NOT a commitment — do not write it. An implicit owner ("we'll get to it") is written low-confidence with a best-guess `made_by` flagged uncertain.
- **Surface floor (θ ≈ 0.5):** phrasing sets confidence. "will", "I'll", "by <date>" → high, above the floor. "should", "could", "ought" → below the floor: still written, but low. Borderline promises are recorded low, not dropped.

## Turn finished jobs into graph facts

When a batch carries a finished-job result for a chat's work, record the earned edges `works_on` (author → issue/PR) and `resolves` (PR → issue). Do not restate the PR's labels or body — GitHub already serves those. These edges are idempotent, so a duplicate delivery cannot amplify confidence. In the same pass, if a commitment's `about` target is an issue/PR that merged or closed, flip that commitment `open → done`.

See the tool descriptions for the eleven entity and relation types and their keys. Evidence
references are supplied in the Scribe Batch by trusted runtime code. For every Entity or Relation,
pass the smallest non-empty subset of those `evidenceIds` that actually supports that claim. Never
invent an id, attach an unrelated message, or include a provenance object in a tool call; application
code rejects ids outside the Batch.
