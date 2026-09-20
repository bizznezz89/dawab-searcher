import {
  formatEther,
  formatUnits,
} from "ethers";

import type {
  EthereumVerification,
  IndependentVerification,
  MarketObservation,
  OpportunityCandidate,
  OpportunitySweep,
  RhcVerification,
} from "./types.js";
import type {
  PhaseOneAssessment,
} from "./strategy/crossChainArb.js";

const BILLION = 1_000_000_000;

function formatBillions(
  decimalString: string,
): string {
  const value = Number(decimalString);

  if (!Number.isFinite(value)) {
    return decimalString;
  }

  return `${(value / BILLION).toFixed(3)}B`;
}

function formatRawWabitBillions(
  raw: bigint,
): string {
  return formatBillions(
    formatUnits(raw, 18),
  );
}

function signedPercent(
  value: number,
): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(6)}%`;
}

function signedBps(
  value: number | null,
): string {
  if (value == null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} bps`;
}

function signedWeth(
  raw: bigint | null,
  decimals = 8,
): string {
  if (raw == null) return "n/a";

  const sign =
    raw > 0n ? "+" : "";

  return `${sign}${Number(
    formatEther(raw),
  ).toFixed(decimals)}`;
}

function weth(
  raw: bigint,
  decimals = 6,
): string {
  return Number(
    formatEther(raw),
  ).toFixed(decimals);
}

function gwei(
  rawWei: bigint,
): string {
  return Number(
    formatUnits(rawWei, "gwei"),
  ).toFixed(6);
}

function pass(
  value: boolean,
): string {
  return value ? "PASS" : "FAIL";
}

function shortDirection(
  candidate: OpportunityCandidate,
): string {
  return candidate.direction ===
    "BUY_ETH_SELL_RHC"
    ? "ETH→RHC"
    : "RHC→ETH";
}

export interface ObservationRenderOptions {
  searcherMode?:
    "PAPER" | "LIVE";

  marketSource?:
    "PUBLIC_FEED" | "DIRECT_RPC";

  publicFeedStatus?:
    string;
}

export function renderObservation(
  observation:
    MarketObservation,
  assessment:
    PhaseOneAssessment,
  options:
    ObservationRenderOptions = {},
): string {
  const ageSeconds =
    Math.max(
      0,
      observation.ageMs / 1000,
    );

  const searcherMode =
    options.searcherMode ??
    "PAPER";

  const marketSource =
    options.marketSource ??
    "PUBLIC_FEED";

  const lines = [
    "",
    "DaWabLauncher Reference Searcher",
    "────────────────────────────────",
    `Searcher mode:   ${searcherMode}`,
    `Market source:   ${marketSource}`,
  ];

  if (
    options.publicFeedStatus
  ) {
    lines.push(
      `Public feed:     ${options.publicFeedStatus}`,
    );
  }

  lines.push(
    `Snapshot age:    ${ageSeconds.toFixed(1)}s`,
    `RHC block:       ${observation.rhcBlock}`,
    `Ethereum block:  ${observation.ethereumBlock}`,
    `RHC venue:       ${observation.rhcVenue}`,
    "",
    "Same-notional market comparison",
    `Input:           ${observation.notionalWeth} WETH`,
    "",
    `Ethereum:        ${formatBillions(
      observation.ethereumWabitOut,
    )} WABIT`,
    `RHC:             ${formatBillions(
      observation.rhcWabitOut,
    )} WABIT`,
    "",
    `RHC price spread:   ${signedPercent(
      observation.priceSpreadPct,
    )}`,
    `RHC output diff:    ${signedPercent(
      observation.outputDifferencePct,
    )}`,
    `Venue signal:       ${observation.venueSignal}`,
    "",
    `Strategy decision:  ${assessment.decision}`,
    "",
  );

  return lines.join("\n");
}

export function renderVerification(
  verification: IndependentVerification,
): string {
  const eth = verification.ethereum;
  const rhc = verification.rhc;

  return [
    "Independent RPC verification",
    "────────────────────────────",
    `Ethereum chain:   ${eth.chainId.toString()} @ block ${eth.blockNumber}`,
    `ETH pair factory: ${pass(
      eth.canonicalUniswapV2Factory,
    )} (canonical Uniswap V2)`,
    "",
    `ETH feed output:  ${formatRawWabitBillions(
      verification.ethereumFeedMatch.feedRaw,
    )} WABIT`,
    `ETH RPC output:   ${formatRawWabitBillions(
      verification.ethereumFeedMatch.rpcRaw,
    )} WABIT`,
    `ETH difference:   ${verification.ethereumFeedMatch.differenceBps.toFixed(
      4,
    )} bps  ${verification.ethereumFeedMatch.status}`,
    "",
    `RHC chain:        ${rhc.chainId.toString()} @ block ${rhc.blockNumber}`,
    `RHC venue:        ${rhc.venueName}`,
    `RHC feed output:  ${formatRawWabitBillions(
      verification.rhcFeedMatch.feedRaw,
    )} WABIT`,
    `RHC RPC output:   ${formatRawWabitBillions(
      verification.rhcFeedMatch.rpcRaw,
    )} WABIT`,
    `RHC difference:   ${verification.rhcFeedMatch.differenceBps.toFixed(
      4,
    )} bps  ${verification.rhcFeedMatch.status}`,
    "",
    `Feed verification: ${verification.status}`,
    `Execution basis:   ${verification.executionBasis}`,
    "",
  ].join("\n");
}


export function renderLiveDirectVerification(
  ethereum:
    EthereumVerification,
  rhc:
    RhcVerification,
  feedCrossCheck:
    IndependentVerification | null,
  feedMessage:
    string | null,
): string {
  const feedStatus =
    feedCrossCheck
      ? feedCrossCheck.status ===
        "PASS"
        ? "PASS"
        : "MISMATCH (advisory)"
      : `UNAVAILABLE (advisory)${
          feedMessage
            ? ` — ${feedMessage}`
            : ""
        }`;

  return [
    "Live direct RPC verification",
    "────────────────────────────",
    `Ethereum chain:   ${ethereum.chainId.toString()} @ block ${ethereum.blockNumber}`,
    `ETH pair factory: ${pass(
      ethereum.canonicalUniswapV2Factory,
    )} (canonical Uniswap V2)`,
    `ETH RPC output:   ${formatRawWabitBillions(
      ethereum.netWabitOutRaw,
    )} WABIT`,
    "",
    `RHC chain:        ${rhc.chainId.toString()} @ block ${rhc.blockNumber}`,
    `RHC venue:        ${rhc.venueName}`,
    `RHC RPC output:   ${formatRawWabitBillions(
      rhc.amountOutWabitRaw,
    )} WABIT`,
    "",
    "Execution basis:  DIRECT_RPC_MARKET_STATE",
    `Public feed xchk: ${feedStatus}`,
    "",
  ].join("\n");
}

function renderCandidate(
  candidate: OpportunityCandidate,
): string {
  const requested =
    weth(
      candidate.requestedWethRaw,
      8,
    );

  const wabit =
    formatRawWabitBillions(
      candidate.acquiredWabitRaw,
    );

  const gross =
    signedWeth(
      candidate.grossProfitWethRaw,
    );

  const source =
    candidate.source ===
      "RHC_SELL_CAPACITY"
      ? " [capacity]"
      : candidate.source ===
          "OPTIMIZED"
        ? " [optimized]"
        : "";

  const lines = [
    `${requested.padStart(11)} WETH  ${shortDirection(
      candidate,
    ).padEnd(7)}  WABIT ${wabit.padStart(
      12,
    )}  gross ${gross.padStart(
      12,
    )} (${signedBps(
      candidate.grossProfitBps,
    ).padStart(12)})  ${candidate.fillStatus}${source}`,
  ];

  if (candidate.quoteFailure) {
    lines.push(
      `                           ↳ ${candidate.quoteFailure.errorName}${
        candidate.quoteFailure.errorData
          ? ` ${candidate.quoteFailure.errorData.slice(
              0,
              10,
            )}`
          : ""
      }`,
    );
  }

  if (
    candidate.netProfitWethRaw != null
  ) {
    lines.push(
      `                           net ${signedWeth(
        candidate.netProfitWethRaw,
      ).padStart(12)} (${signedBps(
        candidate.netProfitBps,
      )})`,
    );
  }

  return lines.join("\n");
}

function renderBest(
  label: string,
  candidate: OpportunityCandidate | null,
  net: boolean,
): string {
  if (!candidate) {
    return `${label}: none`;
  }

  const profit =
    net
      ? candidate.netProfitWethRaw
      : candidate.grossProfitWethRaw;

  const bps =
    net
      ? candidate.netProfitBps
      : candidate.grossProfitBps;

  const source =
    candidate.source ===
      "OPTIMIZED"
      ? " [optimized]"
      : candidate.source ===
          "RHC_SELL_CAPACITY"
        ? " [capacity boundary]"
        : "";

  return `${label}: ${shortDirection(
    candidate,
  )} @ ${weth(
    candidate.requestedWethRaw,
    10,
  )} WETH → ${signedWeth(
    profit,
  )} WETH (${signedBps(bps)})${source}`;
}

export function renderOpportunitySweep(
  sweep:
    OpportunitySweep,
  options: {
    executionMode?:
      "paper" | "live";
  } = {},
): string {
  const capacity =
    sweep.rhcCurve.maxExecutableSellRaw;

  const lines = [
    "Phase 3 two-leg opportunity sweep",
    "─────────────────────────────────",
    `Ethereum gas:     ${gwei(
      sweep.gas.ethereumGasPriceWei,
    )} gwei`,
    `RHC gas:          ${gwei(
      sweep.gas.rhcGasPriceWei,
    )} gwei`,
    `RHC activated:    ${sweep.rhcCurve.activated}`,
    `RHC graduated:    ${sweep.rhcCurve.graduated}`,
    `RHC tokens sold:  ${formatRawWabitBillions(
      sweep.rhcCurve.tokensSoldRaw,
    )} WABIT`,
    `RHC max sell:     ${
      capacity == null
        ? "n/a (AMM)"
        : `${formatRawWabitBillions(
            capacity,
          )} WABIT`
    }`,
    `Reserve-limited:  ${sweep.rhcCurve.capacityLimitedByReserve}`,
    `RHC quote reserve:${weth(
      sweep.rhcCurve.quoteReserveRaw,
      8,
    ).padStart(13)} WETH`,
    "",
  ];

  for (
    const candidate of sweep.candidates
  ) {
    lines.push(
      renderCandidate(candidate),
    );
  }

  lines.push("");

  if (
    sweep.optimizer.ran &&
    sweep.optimizer.direction &&
    sweep.optimizer.lowerBoundWethRaw != null &&
    sweep.optimizer.upperBoundWethRaw != null
  ) {
    lines.push(
      `Optimizer: ${sweep.optimizer.direction === "BUY_ETH_SELL_RHC" ? "ETH→RHC" : "RHC→ETH"} | bracket ${weth(
        sweep.optimizer.lowerBoundWethRaw,
        8,
      )}–${weth(
        sweep.optimizer.upperBoundWethRaw,
        8,
      )} WETH | ${sweep.optimizer.iterations} iterations`,
    );
  } else {
    lines.push(
      "Optimizer: not run — no positive coarse candidate",
    );
  }

  lines.push(
    renderBest(
      "Best gross",
      sweep.bestGross,
      false,
    ),
  );

  if (
    options.executionMode ===
    "live"
  ) {
    lines.push(
      "Best net: calculated later from exact live estimateGas + protected preflight",
    );

    lines.push("");
    lines.push(
      "Execution status: HOT_PREFLIGHT_REQUIRED",
    );
    lines.push(
      "Positive gross P&L is only a candidate; direct live revalidation, exact gas, protection, and static-call checks remain mandatory.",
    );
  } else {
    if (sweep.gasModelConfigured) {
      lines.push(
        renderBest(
          "Best net",
          sweep.bestNet,
          true,
        ),
      );
    } else {
      lines.push(
        "Best net: deferred to the cold execution model; no manual gas-unit profile is configured",
      );
    }

    lines.push("");
    lines.push(
      `Execution status: ${sweep.executionStatus}`,
    );
    lines.push(
      "Positive gross P&L is an economic signal; the cold fork simulation remains the paper execution gate.",
    );
  }

  lines.push("");

  return lines.join("\n");
}
