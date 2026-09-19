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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is required for Phase 2 independent verification`,
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

  verificationIntervalMs: numberFromEnv(
    "VERIFY_INTERVAL_MS",
    60_000,
  ),

  verificationToleranceBps: numberFromEnv(
    "VERIFY_TOLERANCE_BPS",
    10,
  ),

  ethereumRpcUrl: requiredEnv(
    "ETHEREUM_RPC_URL",
  ),

  // Optional. Tatum uses this as x-api-key.
  // Infura/Alchemy normally authenticate in the URL and can leave it blank.
  ethereumRpcApiKey:
    process.env.ETHEREUM_RPC_API_KEY?.trim() ||
    null,

  rhcRpcUrl:
    process.env.RHC_RPC_URL?.trim() ||
    "https://rpc.mainnet.chain.robinhood.com",

  executionEnabled:
    process.env.ENABLE_EXECUTION === "true",
});

if (config.mode !== "paper") {
  throw new Error(
    `Phase 2 supports MODE=paper only; received ${config.mode}`,
  );
}

if (config.executionEnabled) {
  throw new Error(
    "Phase 2 refuses ENABLE_EXECUTION=true. Live execution is not implemented.",
  );
}

if (
  config.verificationToleranceBps < 0 ||
  config.verificationToleranceBps > 100
) {
  throw new Error(
    "VERIFY_TOLERANCE_BPS must be between 0 and 100",
  );
}
