# Evaluate through the production Flue interface

Behavior evaluations use `vitest-evals` to invoke the HTTP-exposed production Ambience agent through `@flue/sdk`, rather than preserving the obsolete Eve eval plan or building a custom runner. Deterministic tests protect modules and invariants, behavior evaluations replay Managed Chat scenarios and assert tool calls plus resulting state, and a small separately-gated live provider suite verifies adapter contracts; model judges are reserved for subjective quality, never structural correctness.
