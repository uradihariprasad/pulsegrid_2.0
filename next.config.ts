import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Long-lived SSE connections must survive proxies
  httpAgentOptions: {
    keepAlive: true,
  },
};

export default nextConfig;
