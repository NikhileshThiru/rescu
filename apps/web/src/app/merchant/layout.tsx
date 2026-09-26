import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Merchant terminal · Rescu",
  description: "Any relief store's shelf, prices, live payments and counter QR charges.",
};

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  return children;
}
