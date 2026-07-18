import path from "node:path";
import "@ambient-agent/env/web";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  output: "standalone",
  // Monorepo root: silence Next's multi-lockfile root inference and keep
  // standalone tracing anchored to the workspace, not a stray parent lockfile.
  turbopack: {
    root: path.join(import.meta.dirname, "..", ".."),
  },
};

export default nextConfig;
