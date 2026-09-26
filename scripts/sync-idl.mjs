// Copies the Anchor build output into @rescu/chain so apps never need a Rust toolchain.
import { copyFileSync, mkdirSync } from "node:fs";

const out = new URL("../packages/chain/src/idl/", import.meta.url);
mkdirSync(out, { recursive: true });
copyFileSync(new URL("../target/idl/rescu.json", import.meta.url), new URL("rescu.json", out));
copyFileSync(new URL("../target/types/rescu.ts", import.meta.url), new URL("rescu.ts", out));
console.log("synced IDL -> packages/chain/src/idl");
