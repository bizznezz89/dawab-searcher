import {
  formatEther,
} from "ethers";

import {
  ADDRESSES,
} from "../contracts.js";
import {
  fetchDaWabState,
} from "../market/dawablauncher.js";
import {
  getEthereumGasPrice,
  modelEthereumBuy,
  verifyEthereumBuy,
} from "../market/ethereum.js";
import {
  getRhcCurveState,
  getRhcGasPrice,
  tryQuoteRhcExactInput,
  verifyRhcBuy,
} from "../market/rhc.js";
import type {
  Phase4Simulation,
} from "../simulation/fork.js";
import {
  verifyAgainstFeed,
} from "../verification.js";

export type PaperGateAction =
  | "WOULD_EXECUTE"
  | "SKIP";

export interface PaperExecutionGate {
  generatedAt: string;
  action: PaperGateAction;
  reason: string;

  direction:
    | "BUY_ETH_SELL_RHC";

  inputWethRaw: bigint;

  verificationStatus:
    | "PASS"
    | "FAIL";

  ethereumBlock: number;
  rhcBlock: number;

  ethereumWabitOutRaw: bigint;
  rhcWethOutRaw: bigint;

  grossProfitWethRaw: bigint;
  gasCostWethRaw: bigint;
  netProfitWethRaw: bigint;
  netProfitBps: number;

  ethereumOutputDriftBps: number;
  routeOutputDriftBps: number;

  ethereumGasPriceWei: bigint;
  rhcGasPriceWei: bigint;

  ethereumGasUnits: bigint;
  rhcGasUnits: bigint;

  venue: string;
}

function absolute(
  value: bigint,
): bigint {
  return value < 0n
    ? -value
    : value;
}

function differenceBps(
  actual: bigint,
  reference: bigint,
): number {
  if (reference === 0n) {
    return actual === 0n
      ? 0
      : Number.POSITIVE_INFINITY;
  }

  const scaled =
    (
      absolute(
        actual - reference,
      ) *
      1_000_000n
    ) /
    reference;

  return Number(scaled) / 100;
}

function signedBps(
  value: bigint,
  base: bigint,
): number {
  if (base <= 0n) {
    return 0;
  }

  const scaled =
    (value * 1_000_000n) /
    base;

  return Number(scaled) / 100;
}

export async function evaluatePaperExecutionGate(
  simulation: Phase4Simulation,
): Promise<PaperExecutionGate> {
  const candidate =
    simulation.candidate;

  if (
    candidate.direction !==
    "BUY_ETH_SELL_RHC"
  ) {
    throw new Error(
      `Phase 5A paper gate currently supports BUY_ETH_SELL_RHC only; received ${candidate.direction}`,
    );
  }

  /*
   * Re-read the public feed and both chains AFTER Phase 4.
   *
   * The gate therefore does not rely on the market snapshot that originally
   * triggered the simulation.
   */
  const state =
    await fetchDaWabState();

  const [
    ethereum,
    rhcVerification,
  ] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
    ]);

  const verification =
    verifyAgainstFeed(
      state,
      ethereum,
      rhcVerification,
    );

  const freshEthereumBuy =
    modelEthereumBuy(
      candidate.requestedWethRaw,
      ethereum,
    );

  const [
    rhcCurve,
    ethereumGasPriceWei,
    rhcGasPriceWei,
  ] =
    await Promise.all([
      getRhcCurveState(),
      getEthereumGasPrice(),
      getRhcGasPrice(),
    ]);

  const ethereumGasUnits =
    simulation.ethereum.gasUsed;

  const rhcGasUnits =
    simulation.rhc.gasUsed;

  const gasCostWethRaw =
    ethereumGasUnits *
      ethereumGasPriceWei +
    rhcGasUnits *
      rhcGasPriceWei;

  const base = {
    generatedAt:
      new Date().toISOString(),

    direction:
      "BUY_ETH_SELL_RHC" as const,

    inputWethRaw:
      candidate.requestedWethRaw,

    verificationStatus:
      verification.status,

    ethereumBlock:
      ethereum.blockNumber,

    rhcBlock:
      rhcVerification.blockNumber,

    ethereumWabitOutRaw:
      freshEthereumBuy.netWabitOutRaw,

    ethereumOutputDriftBps:
      differenceBps(
        freshEthereumBuy.netWabitOutRaw,
        simulation.ethereum
          .actualOutputRaw,
      ),

    ethereumGasPriceWei,
    rhcGasPriceWei,

    ethereumGasUnits,
    rhcGasUnits,

    gasCostWethRaw,
  };

  if (
    verification.status !==
    "PASS"
  ) {
    return {
      ...base,
      action: "SKIP",
      reason:
        "Fresh independent market verification failed after Phase 4.",

      rhcWethOutRaw: 0n,
      grossProfitWethRaw: 0n,
      netProfitWethRaw:
        -gasCostWethRaw,
      netProfitBps:
        signedBps(
          -gasCostWethRaw,
          candidate
            .requestedWethRaw,
        ),

      routeOutputDriftBps:
        Number.POSITIVE_INFINITY,

      venue:
        rhcVerification.venueName,
    };
  }

  /*
   * Phase 4 has currently proven the active BondingCurve route only.
   * If the lifecycle advances to the AMM, stop and require a new fork proof
   * instead of silently treating it as equivalent.
   */
  if (
    rhcCurve.graduated ||
    rhcVerification.venue !== 1n
  ) {
    return {
      ...base,
      action: "SKIP",
      reason:
        "RHC venue changed from the Phase 4-proven active BondingCurve route; re-simulation is required.",

      rhcWethOutRaw: 0n,
      grossProfitWethRaw: 0n,
      netProfitWethRaw:
        -gasCostWethRaw,
      netProfitBps:
        signedBps(
          -gasCostWethRaw,
          candidate
            .requestedWethRaw,
        ),

      routeOutputDriftBps:
        Number.POSITIVE_INFINITY,

      venue:
        rhcVerification.venueName,
    };
  }

  const capacity =
    rhcCurve.maxExecutableSellRaw;

  if (
    capacity != null &&
    freshEthereumBuy
      .netWabitOutRaw >
      capacity
  ) {
    return {
      ...base,
      action: "SKIP",
      reason:
        "Fresh Ethereum WABIT output exceeds the current conservative RHC sell capacity.",

      rhcWethOutRaw: 0n,
      grossProfitWethRaw: 0n,
      netProfitWethRaw:
        -gasCostWethRaw,
      netProfitBps:
        signedBps(
          -gasCostWethRaw,
          candidate
            .requestedWethRaw,
        ),

      routeOutputDriftBps:
        Number.POSITIVE_INFINITY,

      venue: "BondingCurve",
    };
  }

  const quoteResult =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.wabit,
      ADDRESSES.rhc.weth,
      freshEthereumBuy
        .netWabitOutRaw,
    );

  if (!quoteResult.ok) {
    return {
      ...base,
      action: "SKIP",
      reason:
        `Fresh RHC sell quote reverted: ${quoteResult.failure.errorName}`,

      rhcWethOutRaw: 0n,
      grossProfitWethRaw: 0n,
      netProfitWethRaw:
        -gasCostWethRaw,
      netProfitBps:
        signedBps(
          -gasCostWethRaw,
          candidate
            .requestedWethRaw,
        ),

      routeOutputDriftBps:
        Number.POSITIVE_INFINITY,

      venue: "BondingCurve",
    };
  }

  const quote =
    quoteResult.quote;

  if (
    quote.venue !== 1n ||
    quote.amountInUsedRaw !==
      freshEthereumBuy
        .netWabitOutRaw ||
    quote.refundAmountRaw !== 0n
  ) {
    return {
      ...base,
      action: "SKIP",
      reason:
        "Fresh RHC quote is not a full active-curve fill.",

      rhcWethOutRaw:
        quote.amountOutRaw,
      grossProfitWethRaw: 0n,
      netProfitWethRaw:
        -gasCostWethRaw,
      netProfitBps:
        signedBps(
          -gasCostWethRaw,
          candidate
            .requestedWethRaw,
        ),

      routeOutputDriftBps:
        differenceBps(
          quote.amountOutRaw,
          simulation.rhc
            .actualOutputRaw,
        ),

      venue:
        quote.venueName,
    };
  }

  const grossProfitWethRaw =
    quote.amountOutRaw -
    candidate.requestedWethRaw;

  const netProfitWethRaw =
    grossProfitWethRaw -
    gasCostWethRaw;

  const action:
    PaperGateAction =
      netProfitWethRaw > 0n
        ? "WOULD_EXECUTE"
        : "SKIP";

  const reason =
    action ===
    "WOULD_EXECUTE"
      ? "Fresh verified route remains gas-adjusted profitable at the Phase 4-proven trade size."
      : "Fresh verified route is no longer gas-adjusted profitable.";

  return {
    ...base,

    action,
    reason,

    rhcWethOutRaw:
      quote.amountOutRaw,

    grossProfitWethRaw,
    netProfitWethRaw,

    netProfitBps:
      signedBps(
        netProfitWethRaw,
        candidate
          .requestedWethRaw,
      ),

    routeOutputDriftBps:
      differenceBps(
        quote.amountOutRaw,
        simulation.rhc
          .actualOutputRaw,
      ),

    venue:
      quote.venueName,
  };
}

function formatWeth(
  raw: bigint,
  decimals = 8,
): string {
  return Number(
    formatEther(raw),
  ).toFixed(decimals);
}

function signedWeth(
  raw: bigint,
): string {
  return `${raw >= 0n ? "+" : ""}${formatWeth(
    raw,
    8,
  )}`;
}

export function renderPaperExecutionGate(
  gate: PaperExecutionGate,
): string {
  return [
    "",
    "Phase 5A autonomous paper execution gate",
    "────────────────────────────────────────",
    `Fresh verification:     ${gate.verificationStatus}`,
    `Ethereum block:         ${gate.ethereumBlock}`,
    `RHC block:              ${gate.rhcBlock}`,
    `RHC venue:              ${gate.venue}`,
    "",
    `Trade size:             ${formatWeth(
      gate.inputWethRaw,
      10,
    )} WETH`,
    `ETH output drift:       ${Number.isFinite(
      gate.ethereumOutputDriftBps,
    )
      ? gate.ethereumOutputDriftBps.toFixed(
          4,
        )
      : "n/a"} bps`,
    `Route output drift:     ${Number.isFinite(
      gate.routeOutputDriftBps,
    )
      ? gate.routeOutputDriftBps.toFixed(
          4,
        )
      : "n/a"} bps`,
    "",
    `Fresh gross profit:     ${signedWeth(
      gate.grossProfitWethRaw,
    )} WETH`,
    `Fresh modeled gas:      -${formatWeth(
      gate.gasCostWethRaw,
      8,
    )} WETH`,
    `Fresh modeled net:      ${signedWeth(
      gate.netProfitWethRaw,
    )} WETH`,
    `Fresh modeled return:   ${gate.netProfitBps >= 0 ? "+" : ""}${(
      gate.netProfitBps /
      100
    ).toFixed(4)}%`,
    "",
    `PAPER ACTION:           ${gate.action}`,
    `Reason:                 ${gate.reason}`,
    "Signing:                DISABLED",
    "Broadcast:              DISABLED",
    "",
  ].join("\n");
}
