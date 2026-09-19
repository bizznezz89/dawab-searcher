export type VenueSignal =
  | "RHC_CHEAPER"
  | "ETHEREUM_CHEAPER"
  | "PARITY";

export interface SearcherStateV03 {
  ok: true;
  schemaVersion: "0.3";
  generatedAt: string;
  rhc: {
    chainId: number;
    blockNumber: string;
    market: string;
    venue: {
      id: string | number;
      name: string;
    };
  };
  ethereumReference: {
    available: boolean;
    chainId: number;
    blockNumber: string;
  };
  marketSignal: {
    available: boolean;
    referenceType: string;
    sameNotionalBuy: {
      available: boolean;
      comparable: boolean;
      notionalWeth: {
        raw: string;
        formatted: string;
      };
      method: string;
      ethereum: {
        venue: string;
        pair: string;
        factory?: string;
        inputWeth: {
          raw: string;
          formatted: string;
        };
        grossWabitOut?: {
          raw: string;
          formatted: string;
        };
        transferBurn?: {
          raw: string;
          formatted: string;
        };
        netWabitOut: {
          raw: string;
          formatted: string;
        };
        effectiveWethPerWabitApprox: string;
      };
      rhc: {
        venue: string;
        inputWeth: {
          raw: string;
          formatted: string;
        };
        amountInUsed?: {
          raw: string;
          formatted: string;
        };
        outputWabit: {
          raw: string;
          formatted: string;
        };
        refundWeth: {
          raw: string;
          formatted: string;
        };
        effectiveWethPerWabitApprox: string;
      };
      priceSpreadPct: {
        pct: string;
        label: "discount" | "premium" | string;
        definition: string;
      };
      outputDifferencePct: {
        pct: string;
        definition: string;
      };
      note: string;
    };
  };
  execution: {
    capitalProvided: boolean;
    privateKeysHandled: boolean;
    transactionsBroadcast: boolean;
  };
}

export interface MarketObservation {
  generatedAt: string;
  ageMs: number;
  rhcBlock: string;
  ethereumBlock: string;
  rhcVenue: string;
  notionalWeth: string;
  ethereumWabitOut: string;
  rhcWabitOut: string;
  ethereumEffectiveWethPerWabit: string;
  rhcEffectiveWethPerWabit: string;
  priceSpreadPct: number;
  outputDifferencePct: number;
  venueSignal: VenueSignal;
  executionStatus: "UNVERIFIED";
}

export interface EthereumVerification {
  chainId: bigint;
  blockNumber: number;
  pair: string;
  factory: string;
  canonicalUniswapV2Factory: boolean;
  token0: string;
  token1: string;
  wethReserveRaw: bigint;
  wabitReserveRaw: bigint;
  amountInWethRaw: bigint;
  grossWabitOutRaw: bigint;
  transferBurnRaw: bigint;
  netWabitOutRaw: bigint;
}

export interface EthereumBuyModel {
  inputWethRaw: bigint;
  grossWabitOutRaw: bigint;
  transferBurnRaw: bigint;
  netWabitOutRaw: bigint;
}

export interface EthereumSellModel {
  inputWabitRaw: bigint;
  transferBurnRaw: bigint;
  amountReceivedByPairRaw: bigint;
  wethOutRaw: bigint;
}

export interface RhcExactInputQuote {
  venue: bigint;
  venueName: string;
  tokenIn: string;
  tokenOut: string;
  amountInRequestedRaw: bigint;
  amountInUsedRaw: bigint;
  amountOutRaw: bigint;
  refundAmountRaw: bigint;
}

export interface RhcQuoteFailure {
  errorName: string;
  errorData: string | null;
  message: string;
}

export interface RhcCurveState {
  activated: boolean;
  graduated: boolean;
  tokensSoldRaw: bigint;
  quoteReserveRaw: bigint;
  maxExecutableSellRaw: bigint | null;
  capacityLimitedByReserve: boolean;
}

export interface RhcVerification {
  chainId: bigint;
  blockNumber: number;
  venue: bigint;
  venueName: string;
  amountInRequestedRaw: bigint;
  amountInUsedRaw: bigint;
  amountOutWabitRaw: bigint;
  refundWethRaw: bigint;
}

export interface FeedLegVerification {
  status: "PASS" | "FAIL";
  feedRaw: bigint;
  rpcRaw: bigint;
  differenceBps: number;
}

export interface IndependentVerification {
  status: "PASS" | "FAIL";
  ethereum: EthereumVerification;
  rhc: RhcVerification;
  ethereumFeedMatch: FeedLegVerification;
  rhcFeedMatch: FeedLegVerification;
  toleranceBps: number;
  executionBasis:
    | "VERIFIED_MARKET_STATE"
    | "UNVERIFIED_MARKET_STATE";
  arbExecution: "NOT_YET_PROVEN";
}

export type ArbDirection =
  | "BUY_ETH_SELL_RHC"
  | "BUY_RHC_SELL_ETH";

export type OpportunityFillStatus =
  | "FULL"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "CAPACITY_LIMITED"
  | "QUOTE_REVERTED";

export type OpportunitySource =
  | "SWEEP"
  | "RHC_SELL_CAPACITY"
  | "OPTIMIZED";

export interface GasSnapshot {
  ethereumGasPriceWei: bigint;
  rhcGasPriceWei: bigint;
}

export interface GasUnitProfile {
  ethereumBuy: bigint | null;
  ethereumSell: bigint | null;
  rhcBuy: bigint | null;
  rhcSell: bigint | null;
}

export interface OpportunityCandidate {
  direction: ArbDirection;
  source: OpportunitySource;
  requestedWethRaw: bigint;
  actualWethSpentRaw: bigint;
  acquiredWabitRaw: bigint;
  sellWabitRequestedRaw: bigint;
  sellWabitUsedRaw: bigint;
  sellWabitRefundRaw: bigint;
  outputWethRaw: bigint;
  buyVenue: string;
  sellVenue: string;
  fillStatus: OpportunityFillStatus;
  quoteFailure: RhcQuoteFailure | null;
  grossProfitWethRaw: bigint | null;
  grossProfitBps: number | null;
  gasCostWethRaw: bigint | null;
  netProfitWethRaw: bigint | null;
  netProfitBps: number | null;
}

export interface OptimizerSummary {
  ran: boolean;
  direction: ArbDirection | null;
  iterations: number;
  lowerBoundWethRaw: bigint | null;
  upperBoundWethRaw: bigint | null;
}

export interface OpportunitySweep {
  generatedAt: string;
  gas: GasSnapshot;
  gasUnits: GasUnitProfile;
  gasModelConfigured: boolean;
  rhcCurve: RhcCurveState;
  optimizer: OptimizerSummary;
  candidates: OpportunityCandidate[];
  bestGross: OpportunityCandidate | null;
  bestNet: OpportunityCandidate | null;
  executionStatus: "NOT_SIMULATED";
}
