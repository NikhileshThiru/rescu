"use client";

import dynamic from "next/dynamic";

const OracleConsole = dynamic(() => import("@/components/oracle/oracle-console").then((m) => m.OracleConsole), { ssr: false });

export default function Page() {
  return <OracleConsole />;
}
