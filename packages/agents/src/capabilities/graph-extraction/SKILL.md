---
name: graph-extraction
description: Extract the shared-graph ontology from a chat's batched inputs — people, threads, GitHub objects, topics, interest edges, and commitments — recording honestly, not certainly.
---

# Graph extraction

Observe each batch of inputs and record what a later reader will actually use. You are not a write-time matcher: when unsure, write a low-confidence fact rather than nothing, and let confidence carry the ambiguity.

This policy is derived from [MEMORY-STATE-SPEC](https://github.com/AaronAbuUsama/ambient-agent/blob/main/docs/planning/MEMORY-STATE-SPEC.md) §4 (extraction & resolution) and §9 (commitment lifecycle).

## Resolve keyed types by convergence, keyless by phrasing

- People, agents, threads, and GitHub objects have natural keys — record them again whenever seen; re-recording converges on the key and raises confidence. Do not merge by hand unless two nodes are provably the same.
- Topics and commitments have no key. Reuse a node only on the same exact phrasing. Otherwise record a NEW node at reduced confidence — a value that says "I might be duplicating this." Never invent a normalized key to force a match; duplicates are resolved later, socially and by consolidation.

## Extract only what a consumer will read

- Record `mentions` liberally — it is a cheap, low-stakes signal.
- Record `discusses` and `interested_in` conservatively — they feed proactive speaking, where a false positive is spam. Only when the interest is clearly expressed.

## Record commitments passively, with two gates

A commitment is a keyless entity you extract with `record_entity({ commitment })` during normal processing. "Hold me to that" is the same call at confidence 1.0.

- **Owner gate (structural):** a commitment needs exactly one owner (`made_by`). An utterance with no resolvable owner ("someone should look at this") is NOT a commitment — do not write it. An implicit owner ("we'll get to it") is written low-confidence with a best-guess `made_by` flagged uncertain.
- **Surface floor (θ ≈ 0.5):** phrasing sets confidence. "will", "I'll", "by <date>" → high, above the floor. "should", "could", "ought" → below the floor: still written, but low. Borderline promises are recorded low, not dropped.

## Turn finished jobs into graph facts

When a batch carries a finished-job result for a chat's work, record the earned edges `works_on` (author → issue/PR) and `resolves` (PR → issue). Do not restate the PR's labels or body — GitHub already serves those. These edges are idempotent, so a later duplicate webhook only raises confidence. In the same pass, if a commitment's `about` target is an issue/PR that merged or closed, flip that commitment `open → done`.

See the tool descriptions for the eleven entity and relation types and their keys.
