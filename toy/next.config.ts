import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // this frontend is the workspace root (a sibling package-lock.json exists for the contracts)
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
