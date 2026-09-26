import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Rescu · Resident",
  description: "Your relief wallet: aid lands when the storm reaches you; Grok shops for you at verified stores.",
  appleWebApp: { capable: true, title: "Rescu", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function AidLayout({ children }: { children: React.ReactNode }) {
  return children;
}
