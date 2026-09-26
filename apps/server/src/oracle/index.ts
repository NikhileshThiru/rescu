import type { FastifyInstance } from "fastify";
import type { Services } from "../services.js";

/** Oracle routes (`/api/oracle/*`) and the engine that watches every run. Owner: step 6. */
export async function registerOracle(_app: FastifyInstance, _s: Services): Promise<void> {}
