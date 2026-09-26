/**
 * @rescu/oracle: the watchdog's math, pure TS with no I/O. Rule detectors (gouging vs the
 * pre-storm regional median, duplicate identities, velocity, collusion) and an isolation-forest
 * anomaly model. The server's engine (apps/server/src/oracle) feeds it the live network.
 */
export * from "./collusion";
export * from "./forest";
export * from "./gouging";
export * from "./identity";
export * from "./model";
export * from "./stats";
export * from "./velocity";

/** Defaults the engine and the metrics endpoint report. */
export const ORACLE_DEFAULTS = {
  gougePct: 25,
  radiusKm: 50,
  scoreToOpen: 0.5,
  trees: 100,
  sampleSize: 256,
} as const;
