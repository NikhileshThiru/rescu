import type { ApiRoutes } from "@rescu/live";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import type { Services } from "./services.js";

/**
 * The JSON behind every relief mint's metadata uri (`https://rescu.tech/api/token/<id>.json`), so
 * Solana Explorer and wallets show a named token with a logo. Any declaration id works; the live
 * run's gets its storm's name.
 */
export async function registerToken(app: FastifyInstance, s: Services): Promise<void> {
  app.get<{ Params: { file: string } }>("/api/token/:file", async (req, reply): Promise<ApiRoutes["GET /api/token/:file"]["res"]> => {
    const id = req.params.file.replace(/\.json$/, "");
    const run = s.sim.run;
    const storm = run && run.key === id ? run.world.stormName : null;
    reply.header("cache-control", "public, max-age=300");
    return {
      name: storm ? `Relief Dollar · ${storm}` : "Relief Dollar",
      symbol: "rUSD",
      description:
        "Disaster relief on Solana, issued by Rescu. Spendable only at verified stores inside the declared disaster area, at most $200 per order and $300 per 24 hours, checked by a Token-2022 transfer hook on every payment; unspent aid returns to the treasury after 30 days. A demo token on our own validator, not real money.",
      image: `${config.siteUrl}/token.png`,
      external_url: config.siteUrl,
      attributes: [
        { trait_type: "Declaration", value: id },
        ...(storm ? [{ trait_type: "Disaster", value: storm }] : []),
        { trait_type: "Per-order cap", value: "$200" },
        { trait_type: "Rolling 24 h cap", value: "$300" },
        { trait_type: "Expires", value: "30 days after landfall" },
      ],
    };
  });
}
