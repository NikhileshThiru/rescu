import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@rescu/aid-model", "@rescu/live"],
  reactStrictMode: true,
  agentRules: false,
  devIndicators: false,
};

export default config;
