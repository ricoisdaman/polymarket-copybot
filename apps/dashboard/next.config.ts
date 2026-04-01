import type { NextConfig } from "next";
import path from "node:path";

const target = process.env.NEXT_DIST_TARGET;
const distDir = target === "dev" ? ".next-dev" : target === "build" || target === "start" ? ".next-build" : ".next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  distDir
};

export default nextConfig;
