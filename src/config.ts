import "dotenv/config";

function numberFromEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];

  if (raw == null || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} must be a finite number; received ${raw}`,
    );
  }

  return value;
}

export const config = Object.freeze({
  mode: process.env.MODE ?? "paper",

  stateUrl:
    process.env.DAWAB_STATE_URL ??
    "https://dawabit.tech/searcher/state.json",

  pollIntervalMs: numberFromEnv(
    "POLL_INTERVAL_MS",
    5_000,
  ),

  maxStateAgeMs: numberFromEnv(
    "MAX_STATE_AGE_MS",
    5 * 60 * 1000,
  ),

  // Phase 1 does not execute trades.
  executionEnabled:
    process.env.ENABLE_EXECUTION === "true",
});

if (config.mode !== "paper") {
  throw new Error(
    `Phase 1 supports MODE=paper only; received ${config.mode}`,
  );
}

if (config.executionEnabled) {
  throw new Error(
    "Phase 1 refuses ENABLE_EXECUTION=true. Live execution is not implemented.",
  );
}
