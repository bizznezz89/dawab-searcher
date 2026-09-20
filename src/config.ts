import "dotenv/config";

import {
  getAddress,
} from "ethers";

function numberFromEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];

  if (
    raw == null ||
    raw.trim() === ""
  ) {
    return fallback;
  }

  const value =
    Number(raw);

  if (
    !Number.isFinite(value)
  ) {
    throw new Error(
      `${name} must be a finite number; received ${raw}`,
    );
  }

  return value;
}

function requiredEnv(
  name: string,
): string {
  const value =
    process.env[name]
      ?.trim();

  if (!value) {
    throw new Error(
      `${name} is required for independent verification`,
    );
  }

  return value;
}

function optionalBigIntFromEnv(
  name: string,
): bigint | null {
  const raw =
    process.env[name]
      ?.trim();

  if (!raw) {
    return null;
  }

  try {
    const value =
      BigInt(raw);

    if (value <= 0n) {
      throw new Error();
    }

    return value;
  } catch {
    throw new Error(
      `${name} must be a positive integer gas-unit count; received ${raw}`,
    );
  }
}

function positiveBigIntFromEnv(
  name: string,
  fallback: bigint,
): bigint {
  const raw =
    process.env[name]
      ?.trim();

  if (!raw) {
    return fallback;
  }

  try {
    const value =
      BigInt(raw);

    if (value <= 0n) {
      throw new Error();
    }

    return value;
  } catch {
    throw new Error(
      `${name} must be a positive integer; received ${raw}`,
    );
  }
}

function stringListFromEnv(
  name: string,
  fallback: string,
): string[] {
  const raw =
    process.env[name]
      ?.trim() ||
    fallback;

  const values =
    raw
      .split(",")
      .map(
        (value) =>
          value.trim(),
      )
      .filter(Boolean);

  if (
    values.length === 0
  ) {
    throw new Error(
      `${name} must contain at least one value`,
    );
  }

  return values;
}

function optionalAddressFromEnv(
  name: string,
): string | null {
  const raw =
    process.env[name]
      ?.trim();

  if (!raw) {
    return null;
  }

  try {
    return getAddress(raw);
  } catch {
    throw new Error(
      `${name} is not a valid EVM address`,
    );
  }
}

const mode =
  process.env.MODE
    ?.trim()
    .toLowerCase() ||
  "paper";

const executionEnabled =
  process.env
    .ENABLE_EXECUTION ===
  "true";

const executorAddress =
  optionalAddressFromEnv(
    "EXECUTOR_ADDRESS",
  );

const privateKeyRaw =
  process.env
    .EXECUTOR_PRIVATE_KEY
    ?.trim() ||
  "";

export const config =
  Object.freeze({
    mode,

    stateUrl:
      process.env
        .DAWAB_STATE_URL ??
      "https://dawabit.tech/searcher/state.json",

    pollIntervalMs:
      numberFromEnv(
        "POLL_INTERVAL_MS",
        5_000,
      ),

    maxStateAgeMs:
      numberFromEnv(
        "MAX_STATE_AGE_MS",
        5 * 60 * 1000,
      ),

    verificationIntervalMs:
      numberFromEnv(
        "VERIFY_INTERVAL_MS",
        60_000,
      ),

    verificationToleranceBps:
      numberFromEnv(
        "VERIFY_TOLERANCE_BPS",
        10,
      ),

    opportunityTriggerPct:
      numberFromEnv(
        "OPPORTUNITY_TRIGGER_PCT",
        2,
      ),

    sweepWeth:
      stringListFromEnv(
        "SWEEP_WETH",
        "0.001,0.0025,0.005,0.01,0.02,0.05,0.1",
      ),

    optimizerIterations:
      numberFromEnv(
        "OPTIMIZER_ITERATIONS",
        12,
      ),

    optimizerResolutionWei:
      positiveBigIntFromEnv(
        "OPTIMIZER_RESOLUTION_WEI",
        1_000_000_000n,
      ),

    ethereumRpcUrl:
      requiredEnv(
        "ETHEREUM_RPC_URL",
      ),

    ethereumRpcApiKey:
      process.env
        .ETHEREUM_RPC_API_KEY
        ?.trim() ||
      null,

    rhcRpcUrl:
      process.env
        .RHC_RPC_URL
        ?.trim() ||
      "https://rpc.mainnet.chain.robinhood.com",

    gasUnits:
      Object.freeze({
        ethereumBuy:
          optionalBigIntFromEnv(
            "ETH_BUY_GAS_UNITS",
          ),

        ethereumSell:
          optionalBigIntFromEnv(
            "ETH_SELL_GAS_UNITS",
          ),

        rhcBuy:
          optionalBigIntFromEnv(
            "RHC_BUY_GAS_UNITS",
          ),

        rhcSell:
          optionalBigIntFromEnv(
            "RHC_SELL_GAS_UNITS",
          ),
      }),

    executionEnabled,

    executorAddress,

    liveExecution:
      mode === "live" &&
      executionEnabled,
  });

if (
  mode !== "paper" &&
  mode !== "live"
) {
  throw new Error(
    `MODE must be paper or live; received ${mode}`,
  );
}

if (
  executionEnabled &&
  mode !== "live"
) {
  throw new Error(
    "ENABLE_EXECUTION=true requires MODE=live.",
  );
}

if (
  mode === "live" &&
  !executionEnabled
) {
  throw new Error(
    "MODE=live requires ENABLE_EXECUTION=true. Both gates must be intentionally enabled.",
  );
}

if (
  config.liveExecution
) {
  if (
    !executorAddress
  ) {
    throw new Error(
      "EXECUTOR_ADDRESS is required in live mode.",
    );
  }

  if (
    !privateKeyRaw
  ) {
    throw new Error(
      "EXECUTOR_PRIVATE_KEY is required in live mode.",
    );
  }

  const normalized =
    privateKeyRaw.startsWith(
      "0x",
    )
      ? privateKeyRaw
      : `0x${privateKeyRaw}`;

  if (
    !/^0x[0-9a-fA-F]{64}$/.test(
      normalized,
    )
  ) {
    throw new Error(
      "EXECUTOR_PRIVATE_KEY must be a 32-byte EVM private key.",
    );
  }
}

if (
  config
    .verificationToleranceBps <
    0 ||
  config
    .verificationToleranceBps >
    100
) {
  throw new Error(
    "VERIFY_TOLERANCE_BPS must be between 0 and 100",
  );
}

if (
  config
    .opportunityTriggerPct <
  0
) {
  throw new Error(
    "OPPORTUNITY_TRIGGER_PCT cannot be negative",
  );
}

if (
  !Number.isInteger(
    config.optimizerIterations,
  ) ||
  config
    .optimizerIterations <
    0 ||
  config
    .optimizerIterations >
    32
) {
  throw new Error(
    "OPTIMIZER_ITERATIONS must be an integer between 0 and 32",
  );
}
