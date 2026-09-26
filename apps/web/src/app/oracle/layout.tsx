import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Oracle · Rescu",
  description: "The watchdog: gouging and fraud cases with evidence, Grok write-ups and on-chain actions.",
};

export default function OracleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
