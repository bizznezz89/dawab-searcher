import type {
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

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(6)}%`;
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
    `RHC price spread:${" ".repeat(3)}${signedPercent(
      observation.priceSpreadPct,
    )}`,
    `RHC output diff: ${signedPercent(
      observation.outputDifferencePct,
    )}`,
    `Venue signal:    ${observation.venueSignal}`,
    "",
    `Phase 1 decision: ${assessment.decision}`,
    `Execution:        ${observation.executionStatus}`,
    "",
    assessment.reason,
    "",
    "NOTE: Phase 1 consumes DaWabLauncher's public state feed.",
    "      It does not yet independently verify either chain or estimate net P&L.",
    "",
  ].join("\n");
}
