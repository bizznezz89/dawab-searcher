import {
  formatUnits,
} from "ethers";

import type {
  IndependentVerification,
  MarketObservation,
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

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(6)}%`;
}

function pass(value: boolean): string {
  return value ? "PASS" : "FAIL";
}

export function renderObservation(
  observation: MarketObservation,
  assessment: PhaseOneAssessment,
): string {
  const ageSeconds = Math.max(
    0,
    observation.ageMs / 1000,
  );

  return [
    "",
    "DaWabLauncher Reference Searcher",
    "────────────────────────────────",
    "Mode:            PAPER",
    `Snapshot age:    ${ageSeconds.toFixed(1)}s`,
    `RHC block:       ${observation.rhcBlock}`,
    `Ethereum block:  ${observation.ethereumBlock}`,
    `RHC venue:       ${observation.rhcVenue}`,
    "",
    "Same-notional public comparison",
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
    `Public-feed decision: ${assessment.decision}`,
    "",
  ].join("\n");
}

export function renderVerification(
  verification: IndependentVerification,
): string {
  const eth =
    verification.ethereum;
  const rhc =
    verification.rhc;

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
    `Arb execution:     ${verification.arbExecution}`,
    "",
    "Phase 2 independently verifies the observed market state.",
    "Gas, optimal sizing, opposite-leg execution, and net P&L arrive in Phase 3.",
    "",
  ].join("\n");
}
