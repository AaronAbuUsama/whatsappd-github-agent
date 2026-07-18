import path from "node:path";
import "@ambient-agent/env/web";
import type { NextConfig } from "next";

// This app imports workspace packages that live outside apps/web (@ambient-agent/env,
// @ambient-agent/api, ...). The standalone build must trace from the monorepo root so those
// files land in .next/standalone — the Docker runner copies only that and discards the builder.
const monorepoRoot = path.join(import.meta.dirname, "..", "..");

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
};

export default nextConfig;
