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
import {
  evaluateExecutionWalletReadiness,
} from "./readiness.js";
import type {
  ExecutionWalletReadiness,
} from "./readiness.js";
import {
  simulateWalletBootstrap,
} from "./bootstrap.js";
import type {
  WalletBootstrapSimulation,
} from "./bootstrap.js";

export type PaperGateAction =
  | "WOULD_EXECUTE"
  | "SKIP";

/*
 * Phase 5B execution-protection policy.
 *
 * The searcher does not ask the operator for a per-trade slippage number.
 * Instead it retains at least half of the freshly modeled net profit as a
 * protected profit floor and makes only the remaining half available as
 * adverse execution headroom.
 *
 * The same derived bps bound is applied to:
 *   1. Ethereum WABIT output, and
 *   2. RHC WETH output.
 *
 * The RHC WABIT input is exactly the protected Ethereum minimum WABIT output.
 * Therefore a successful Ethereum leg cannot replenish less WABIT than the
 * protected RHC leg is sized to sell.
 */
const NET_RETENTION_BPS =
  5_000n;

const BPS_DENOMINATOR =
  10_000n;

const MAX_DERIVED_SLIPPAGE_BPS =
  9_999;

export interface AutomaticProtectionEnvelope {
  policy:
    "RETAIN_HALF_FRESH_NET";

  retainedNetBps: number;

  freshNetWethRaw: bigint;
  protectedNetFloorWethRaw: bigint;
  executionHeadroomWethRaw: bigint;

  maxSymmetricSlippageBps: number;

  ethereumExpectedWabitRaw: bigint;
  ethereumMinimumWabitRaw: bigint;

  rhcSellInputWabitRaw: bigint;
  rhcExpectedWethAtProtectedInputRaw:
    bigint;
  rhcMinimumWethRaw: bigint;

  protectedNetWethRaw: bigint;
  protectedNetBps: number;
}

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

  protection:
    AutomaticProtectionEnvelope
    | null;

  walletReadiness:
    ExecutionWalletReadiness
    | null;

  bootstrapSimulation:
    WalletBootstrapSimulation
    | null;
}

interface ProtectionPoint {
  slippageBps: number;

  ethereumMinimumWabitRaw:
    bigint;

  rhcExpectedWethRaw:
    bigint;

  rhcMinimumWethRaw:
    bigint;

  protectedNetWethRaw:
    bigint;
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

function applyBpsFloor(
  amount: bigint,
  adverseBps: number,
): bigint {
  const retained =
    BPS_DENOMINATOR -
    BigInt(adverseBps);

  return (
    amount *
    retained
  ) / BPS_DENOMINATOR;
}

function ceilMulDiv(
  amount: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (
    amount *
      numerator +
    denominator -
    1n
  ) / denominator;
}

async function evaluateProtectionPoint(
  expectedEthereumWabitRaw: bigint,
  inputWethRaw: bigint,
  gasCostWethRaw: bigint,
  slippageBps: number,
): Promise<
  ProtectionPoint | null
> {
  const ethereumMinimumWabitRaw =
    applyBpsFloor(
      expectedEthereumWabitRaw,
      slippageBps,
    );

  if (
    ethereumMinimumWabitRaw <=
    0n
  ) {
    return null;
  }

  /*
   * Inventory-neutral sizing:
   *
   * If Ethereum fills at exactly its minimum, this is still the maximum
   * amount the RHC leg is sized to sell.
   */
  const quoteResult =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.wabit,
      ADDRESSES.rhc.weth,
      ethereumMinimumWabitRaw,
    );

  if (!quoteResult.ok) {
    return null;
  }

  const quote =
    quoteResult.quote;

  if (
    quote.venue !== 1n ||
    quote.amountInUsedRaw !==
      ethereumMinimumWabitRaw ||
    quote.refundAmountRaw !== 0n
  ) {
    return null;
  }

  const rhcMinimumWethRaw =
    applyBpsFloor(
      quote.amountOutRaw,
      slippageBps,
    );

  const protectedNetWethRaw =
    rhcMinimumWethRaw -
    inputWethRaw -
    gasCostWethRaw;

  return {
    slippageBps,
    ethereumMinimumWabitRaw,
    rhcExpectedWethRaw:
      quote.amountOutRaw,
    rhcMinimumWethRaw,
    protectedNetWethRaw,
  };
}

export async function deriveAutomaticProtection(
  expectedEthereumWabitRaw: bigint,
  inputWethRaw: bigint,
  gasCostWethRaw: bigint,
  freshNetWethRaw: bigint,
): Promise<
  AutomaticProtectionEnvelope
  | null
> {
  if (
    freshNetWethRaw <= 0n
  ) {
    return null;
  }

  /*
   * Retain at least 50% of current modeled net.
   * Round upward so integer truncation cannot silently weaken the floor.
   */
  const protectedNetFloorWethRaw =
    ceilMulDiv(
      freshNetWethRaw,
      NET_RETENTION_BPS,
      BPS_DENOMINATOR,
    );

  const executionHeadroomWethRaw =
    freshNetWethRaw -
    protectedNetFloorWethRaw;

  /*
   * First prove that the current market can still satisfy the retained-net
   * floor even at 0 bps. If not, state moved while we were deriving the
   * envelope and the paper gate must skip.
   */
  const zeroPoint =
    await evaluateProtectionPoint(
      expectedEthereumWabitRaw,
      inputWethRaw,
      gasCostWethRaw,
      0,
    );

  if (
    zeroPoint == null ||
    zeroPoint
      .protectedNetWethRaw <
      protectedNetFloorWethRaw
  ) {
    return null;
  }

  /*
   * Find the largest whole-bps symmetric adverse-fill allowance that:
   *
   *   ETH expected WABIT
   *     ↓ same derived bps haircut
   *   ETH minimum WABIT
   *     ↓ exact RHC sell input
   *   fresh RHC quote
   *     ↓ same derived bps haircut
   *   RHC minimum WETH
   *
   * still leaves protected net >= 50% of the original fresh modeled net.
   *
   * Monotonicity:
   * increasing the adverse bps lowers both the RHC sell input and its WETH
   * minimum, so protected net cannot improve as the bps bound grows.
   */
  let low = 0;
  let high =
    MAX_DERIVED_SLIPPAGE_BPS;

  let best =
    zeroPoint;

  while (low < high) {
    const mid =
      Math.floor(
        (low + high + 1) /
          2,
      );

    const point =
      await evaluateProtectionPoint(
        expectedEthereumWabitRaw,
        inputWethRaw,
        gasCostWethRaw,
        mid,
      );

    if (
      point != null &&
      point
        .protectedNetWethRaw >=
        protectedNetFloorWethRaw
    ) {
      low = mid;
      best = point;
    } else {
      high =
        mid - 1;
    }
  }

  /*
   * Re-evaluate the final bound so the displayed min outputs come from the
   * latest quote used by the protection calculation rather than a stale
   * binary-search intermediate.
   */
  const finalPoint =
    await evaluateProtectionPoint(
      expectedEthereumWabitRaw,
      inputWethRaw,
      gasCostWethRaw,
      low,
    );

  if (
    finalPoint == null ||
    finalPoint
      .protectedNetWethRaw <
      protectedNetFloorWethRaw
  ) {
    return null;
  }

  best =
    finalPoint;

  return {
    policy:
      "RETAIN_HALF_FRESH_NET",

    retainedNetBps:
      Number(
        NET_RETENTION_BPS,
      ),

    freshNetWethRaw,

    protectedNetFloorWethRaw,

    executionHeadroomWethRaw,

    maxSymmetricSlippageBps:
      best.slippageBps,

    ethereumExpectedWabitRaw:
      expectedEthereumWabitRaw,

    ethereumMinimumWabitRaw:
      best
        .ethereumMinimumWabitRaw,

    rhcSellInputWabitRaw:
      best
        .ethereumMinimumWabitRaw,

    rhcExpectedWethAtProtectedInputRaw:
      best
        .rhcExpectedWethRaw,

    rhcMinimumWethRaw:
      best
        .rhcMinimumWethRaw,

    protectedNetWethRaw:
      best
        .protectedNetWethRaw,

    protectedNetBps:
      signedBps(
        best
          .protectedNetWethRaw,
        inputWethRaw,
      ),
  };
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
      `Phase 5B paper gate currently supports BUY_ETH_SELL_RHC only; received ${candidate.direction}`,
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

    protection: null,
    walletReadiness: null,
    bootstrapSimulation: null,
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

  if (
    netProfitWethRaw <= 0n
  ) {
    return {
      ...base,

      action: "SKIP",

      reason:
        "Fresh verified route is no longer gas-adjusted profitable.",

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

  /*
   * Phase 5B:
   * derive execution protection automatically from the remaining fresh edge.
   */
  const protection =
    await deriveAutomaticProtection(
      freshEthereumBuy
        .netWabitOutRaw,
      candidate
        .requestedWethRaw,
      gasCostWethRaw,
      netProfitWethRaw,
    );

  const walletReadiness =
    protection != null &&
    protection
      .maxSymmetricSlippageBps >
      0
      ? await evaluateExecutionWalletReadiness(
          {
            ethereumWethRequiredRaw:
              candidate
                .requestedWethRaw,

            rhcWabitRequiredRaw:
              protection
                .rhcSellInputWabitRaw,

            ethereumGasUnits,
            rhcGasUnits,

            ethereumGasPriceWei,
            rhcGasPriceWei,
          },
        )
      : null;

  const marketQualified =
    protection != null &&
    protection
      .maxSymmetricSlippageBps >
      0;

  const bootstrapSimulation =
    marketQualified &&
    walletReadiness != null &&
    !walletReadiness.ready
      ? await simulateWalletBootstrap(
          walletReadiness,
          {
            ethereumGasPriceWei,
            rhcGasPriceWei,
          },
        )
      : null;

  const action:
    PaperGateAction =
      marketQualified &&
      walletReadiness?.ready ===
        true
        ? "WOULD_EXECUTE"
        : "SKIP";

  let reason: string;

  if (!marketQualified) {
    reason =
      "Fresh route is profitable, but no positive whole-bps two-leg protection envelope preserves the Phase 5B net-retention floor.";
  } else if (
    walletReadiness == null
  ) {
    reason =
      "Market qualifies, but execution-wallet readiness could not be established.";
  } else if (
    walletReadiness.ready
  ) {
    reason =
      "Fresh verified route is protected, profitable, and the dev wallet is execution-ready.";
  } else if (
    bootstrapSimulation
      ?.simulatedReady
  ) {
    reason =
      "Market qualifies and the dev wallet is not ready yet, but Phase 5D proved the missing wrap/approval bootstrap on forks.";
  } else {
    reason =
      `Market qualifies, but the dev wallet is not execution-ready and the bootstrap path is not fully ready: ${[
        ...walletReadiness.blockers,
        ...(bootstrapSimulation?.blockers ??
          []),
      ].join(" ")}`;
  }

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

    protection,
    walletReadiness,
    bootstrapSimulation,
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

function formatNativeEth(
  raw: bigint,
  decimals = 8,
): string {
  return Number(
    formatEther(raw),
  ).toFixed(decimals);
}

function yesNo(
  value: boolean,
): string {
  return value
    ? "PASS"
    : "FAIL";
}

function formatWabitBillions(
  raw: bigint,
): string {
  const wholeWabit =
    Number(
      formatEther(raw),
    );

  return `${(
    wholeWabit /
    1_000_000_000
  ).toFixed(3)}B`;
}

export function renderPaperExecutionGate(
  gate: PaperExecutionGate,
): string {
  const lines = [
    "",
    "Phase 5 cold-validation paper gate",
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
  ];

  if (gate.protection) {
    const protection =
      gate.protection;

    lines.push(
      "",
      "Automatic execution protection",
      `Policy:                 retain ${(protection.retainedNetBps / 100).toFixed(
        2,
      )}% of fresh net`,
      `Execution headroom:     ${formatWeth(
        protection.executionHeadroomWethRaw,
        8,
      )} WETH`,
      `Derived max slippage:   ${protection.maxSymmetricSlippageBps} bps per leg`,
      "",
      `ETH expected WABIT:     ${formatWabitBillions(
        protection.ethereumExpectedWabitRaw,
      )} WABIT`,
      `ETH minimum WABIT:      ${formatWabitBillions(
        protection.ethereumMinimumWabitRaw,
      )} WABIT`,
      `RHC sell WABIT:         ${formatWabitBillions(
        protection.rhcSellInputWabitRaw,
      )} WABIT`,
      `RHC expected WETH:      ${formatWeth(
        protection.rhcExpectedWethAtProtectedInputRaw,
        10,
      )} WETH`,
      `RHC minimum WETH:       ${formatWeth(
        protection.rhcMinimumWethRaw,
        10,
      )} WETH`,
      "",
      `Protected net floor:    ${signedWeth(
        protection.protectedNetFloorWethRaw,
      )} WETH`,
      `Protected modeled net:  ${signedWeth(
        protection.protectedNetWethRaw,
      )} WETH`,
      `Protected return:       ${protection.protectedNetBps >= 0 ? "+" : ""}${(
        protection.protectedNetBps /
        100
      ).toFixed(4)}%`,
    );
  } else if (
    gate.netProfitWethRaw >
    0n
  ) {
    lines.push(
      "",
      "Automatic execution protection",
      "Envelope:               UNAVAILABLE",
    );
  }

  if (gate.walletReadiness) {
    const wallet =
      gate.walletReadiness;

    lines.push(
      "",
      "Read-only execution wallet readiness",
      `Wallet:                 ${wallet.wallet}`,
      "",
      "Ethereum",
      `Native ETH:             ${formatNativeEth(
        wallet.ethereum.nativeBalanceWei,
        8,
      )} ETH`,
      `WETH balance:           ${formatWeth(
        wallet.ethereum.wethBalanceRaw,
        8,
      )} WETH`,
      `WETH required:          ${formatWeth(
        wallet.ethereum.requiredTradeAssetRaw,
        8,
      )} WETH`,
      `WETH inventory:         ${yesNo(
        wallet.ethereum.tradeAssetReady,
      )}`,
      `WETH allowance:         ${yesNo(
        wallet.ethereum.allowanceReady,
      )}`,
      `Native gas:             ${yesNo(
        wallet.ethereum.nativeGasReady,
      )}`,
      `WETH trade runway:      ${wallet.ethereum.tradeAssetRunway.toString()} trade(s)`,
      `ETH gas runway:         ${wallet.ethereum.gasRunway.toString()} trade(s)`,
      `ETH-side WABIT:         ${formatWabitBillions(
        wallet.ethereum.wabitBalanceRaw,
      )} WABIT (reverse inventory; not required now)`,
    );

    if (
      wallet.ethereum
        .wethWrapNeededRaw >
      0n
    ) {
      lines.push(
        `WETH wrap needed:      ${formatWeth(
          wallet.ethereum.wethWrapNeededRaw,
          8,
        )} WETH`,
        `Can self-fund wrap:     ${wallet.ethereum.canSelfFundRequiredWrap ? "YES" : "NO"}`,
      );
    }

    lines.push(
      "",
      "RHC",
      `Native RHC-ETH:         ${formatNativeEth(
        wallet.rhc.nativeBalanceWei,
        8,
      )} ETH`,
      `WABIT balance:          ${formatWabitBillions(
        wallet.rhc.wabitBalanceRaw,
      )} WABIT`,
      `WABIT required:         ${formatWabitBillions(
        wallet.rhc.requiredTradeAssetRaw,
      )} WABIT`,
      `WABIT inventory:        ${yesNo(
        wallet.rhc.tradeAssetReady,
      )}`,
      `WABIT allowance:        ${yesNo(
        wallet.rhc.allowanceReady,
      )}`,
      `Native gas:             ${yesNo(
        wallet.rhc.nativeGasReady,
      )}`,
      `WABIT trade runway:     ${wallet.rhc.tradeAssetRunway.toString()} trade(s)`,
      `RHC gas runway:         ${wallet.rhc.gasRunway.toString()} trade(s)`,
      `RHC WETH:               ${formatWeth(
        wallet.rhc.wethBalanceRaw,
        8,
      )} WETH (reverse inventory; not required now)`,
      "",
      `EXECUTION READINESS:    ${wallet.ready ? "READY" : "NOT_READY"}`,
    );

    if (
      wallet.blockers.length >
      0
    ) {
      for (
        const blocker of
        wallet.blockers
      ) {
        lines.push(
          `  ↳ ${blocker}`,
        );
      }
    }
  }

  if (gate.bootstrapSimulation) {
    const bootstrap =
      gate.bootstrapSimulation;

    lines.push(
      "",
      "Phase 5D fork-simulated wallet bootstrap",
      `ETH WETH wrap:          ${
        bootstrap.ethereumWrap.needed
          ? "WOULD_WRAP"
          : "NOT_NEEDED"
      }`,
      `Wrap amount:            ${formatWeth(
        bootstrap.ethereumWrap.amountRaw,
        8,
      )} ETH`,
      `Wrap gas used:          ${bootstrap.ethereumWrap.gasUsed.toString()}`,
      `ETH WETH approval:      ${
        bootstrap.ethereumApproval.needed
          ? "WOULD_APPROVE"
          : "NOT_NEEDED"
      }`,
      `ETH approval gas:       ${bootstrap.ethereumApproval.gasUsed.toString()}`,
      `RHC WABIT approval:     ${
        bootstrap.rhcApproval.needed
          ? "WOULD_APPROVE"
          : "NOT_NEEDED"
      }`,
      `RHC approval gas:       ${bootstrap.rhcApproval.gasUsed.toString()}`,
      "",
      `ETH bootstrap+trade:    ${formatNativeEth(
        bootstrap.ethereumNativeRequiredWei,
        8,
      )} ETH required`,
      `ETH native capacity:    ${
        bootstrap.ethereumNativeSufficient
          ? "PASS"
          : "FAIL"
      }`,
      `RHC bootstrap+trade:    ${formatNativeEth(
        bootstrap.rhcNativeRequiredWei,
        8,
      )} ETH required`,
      `RHC native capacity:    ${
        bootstrap.rhcNativeSufficient
          ? "PASS"
          : "FAIL"
      }`,
      "",
      `POST-BOOTSTRAP READY:   ${
        bootstrap.simulatedReady
          ? "YES"
          : "NO"
      }`,
      "Bootstrap broadcast:    DISABLED",
    );

    if (
      bootstrap.blockers.length >
      0
    ) {
      for (
        const blocker of
        bootstrap.blockers
      ) {
        lines.push(
          `  ↳ ${blocker}`,
        );
      }
    }
  }

  lines.push(
    "",
    `PAPER ACTION:           ${gate.action}`,
    `Reason:                 ${gate.reason}`,
    "Signing:                DISABLED",
    "Broadcast:              DISABLED",
    "",
  );

  return lines.join("\n");
}
