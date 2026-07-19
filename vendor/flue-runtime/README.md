# Pinned Flue runtime fork

This is the published `@flue/runtime@1.0.0-beta.9` package, vendored so the npm artifact carries the narrow, reviewable `frameworkTools.task` exclusion required by the coding coordinator. The only runtime changes are recorded in [`../../patches/@flue__runtime@1.0.0-beta.9.patch`](../../patches/@flue__runtime@1.0.0-beta.9.patch).

The root package bundles this dependency because consumers cannot apply a pnpm patch from a published transitive package. Upstream provenance remains in `package.json` and `LICENSE`.

Ambient Agent declares the runtime's production dependencies directly, so this
vendored package intentionally omits them. That keeps npm from following pnpm's
virtual-store links while bundling; normal Node resolution finds the same pinned
dependencies from the Ambient Agent package root.
