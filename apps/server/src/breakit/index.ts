import type { FastifyInstance } from "fastify";
import type { Services } from "../services.js";

/** "Try to break it" (`/api/breakit*`): a sandbox declaration and one real attack per case. Owner: step 4. */
export async function registerBreakit(_app: FastifyInstance, _s: Services): Promise<void> {}
