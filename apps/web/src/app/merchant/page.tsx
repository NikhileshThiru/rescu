"use client";

import dynamic from "next/dynamic";

const MerchantTerminal = dynamic(() => import("@/components/merchant/merchant-terminal").then((m) => m.MerchantTerminal), { ssr: false });

export default function Page() {
  return <MerchantTerminal />;
}
