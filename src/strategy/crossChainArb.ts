import type {
  MarketObservation,
} from "../types.js";

export type ReferenceDecision =
  | "NO_EXECUTION_DECISION"
  | "INVESTIGATE_BUY_RHC_SELL_ETH"
  | "INVESTIGATE_BUY_ETH_SELL_RHC";

export interface PhaseOneAssessment {
  decision: ReferenceDecision;
  reason: string;
}

export function assessPhaseOne(
  observation: MarketObservation,
): PhaseOneAssessment {
  if (observation.venueSignal === "RHC_CHEAPER") {
    return {
      decision:
        "INVESTIGATE_BUY_RHC_SELL_ETH",
      reason:
        "RHC is cheaper on the public same-notional buy comparison. Independent RHC buy and Ethereum sell verification is required before calling this executable.",
    };
  }

  if (
    observation.venueSignal ===
    "ETHEREUM_CHEAPER"
  ) {
    return {
      decision:
        "INVESTIGATE_BUY_ETH_SELL_RHC",
      reason:
        "Ethereum is cheaper on the public same-notional buy comparison. Independent Ethereum buy and RHC sell verification is required before calling this executable.",
    };
  }

  return {
    decision: "NO_EXECUTION_DECISION",
    reason:
      "The public same-notional comparison is at parity.",
  };
}
