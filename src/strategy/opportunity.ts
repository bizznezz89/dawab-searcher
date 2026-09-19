import {
  parseEther,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
} from "../contracts.js";
import {
  getEthereumGasPrice,
  modelEthereumBuy,
  modelEthereumSell,
} from "../market/ethereum.js";
import {
  getRhcCurveState,
  getRhcGasPrice,
  tryQuoteRhcExactInput,
} from "../market/rhc.js";
import type {
  ArbDirection,
  EthereumVerification,
  GasSnapshot,
  OpportunityCandidate,
  OpportunitySource,
  OpportunitySweep,
  OptimizerSummary,
  RhcCurveState,
} from "../types.js";

const NEGATIVE_SENTINEL =
  -(1n << 255n);

function signedBps(
  profitRaw: bigint,
  inputRaw: bigint,
): number {
  if (inputRaw <= 0n) return 0;

  const scaled =
    (profitRaw * 1_000_000n) /
    inputRaw;

  return Number(scaled) / 100;
}

function routeGasCost(
  direction: ArbDirection,
  gas: GasSnapshot,
): bigint | null {
  if (
    direction ===
    "BUY_ETH_SELL_RHC"
  ) {
    const ethUnits =
      config.gasUnits.ethereumBuy;
    const rhcUnits =
      config.gasUnits.rhcSell;

    if (
      ethUnits == null ||
      rhcUnits == null
    ) {
      return null;
    }

    return (
      ethUnits *
        gas.ethereumGasPriceWei +
      rhcUnits *
        gas.rhcGasPriceWei
    );
  }

  const rhcUnits =
    config.gasUnits.rhcBuy;
  const ethUnits =
    config.gasUnits.ethereumSell;

  if (
    rhcUnits == null ||
    ethUnits == null
  ) {
    return null;
  }

  return (
    rhcUnits *
      gas.rhcGasPriceWei +
    ethUnits *
      gas.ethereumGasPriceWei
  );
}

function applyGas(
  candidate: OpportunityCandidate,
  gas: GasSnapshot,
): OpportunityCandidate {
  if (
    candidate.grossProfitWethRaw == null
  ) {
    return candidate;
  }

  const gasCost =
    routeGasCost(
      candidate.direction,
      gas,
    );

  if (gasCost == null) {
    return candidate;
  }

  const net =
    candidate.grossProfitWethRaw -
    gasCost;

  return {
    ...candidate,
    gasCostWethRaw: gasCost,
    netProfitWethRaw: net,
    netProfitBps: signedBps(
      net,
      candidate.actualWethSpentRaw,
    ),
  };
}

function emptyCandidate(
  direction: ArbDirection,
  source: OpportunitySource,
  requestedWethRaw: bigint,
  overrides: Partial<OpportunityCandidate>,
): OpportunityCandidate {
  return {
    direction,
    source,
    requestedWethRaw,
    actualWethSpentRaw: 0n,
    acquiredWabitRaw: 0n,
    sellWabitRequestedRaw: 0n,
    sellWabitUsedRaw: 0n,
    sellWabitRefundRaw: 0n,
    outputWethRaw: 0n,
    buyVenue: "Unavailable",
    sellVenue: "Unavailable",
    fillStatus: "UNAVAILABLE",
    quoteFailure: null,
    grossProfitWethRaw: null,
    grossProfitBps: null,
    gasCostWethRaw: null,
    netProfitWethRaw: null,
    netProfitBps: null,
    ...overrides,
  };
}

async function buyEthSellRhc(
  requestedWethRaw: bigint,
  ethereum: EthereumVerification,
  rhcCurve: RhcCurveState,
  source: OpportunitySource,
): Promise<OpportunityCandidate> {
  const buy =
    modelEthereumBuy(
      requestedWethRaw,
      ethereum,
    );

  const activeCapacity =
    rhcCurve.graduated
      ? null
      : rhcCurve.maxExecutableSellRaw;

  if (
    activeCapacity != null &&
    buy.netWabitOutRaw >
      activeCapacity
  ) {
    return emptyCandidate(
      "BUY_ETH_SELL_RHC",
      source,
      requestedWethRaw,
      {
        actualWethSpentRaw:
          requestedWethRaw,
        acquiredWabitRaw:
          buy.netWabitOutRaw,
        sellWabitRequestedRaw:
          buy.netWabitOutRaw,
        buyVenue: "UniswapV2",
        sellVenue: "BondingCurve",
        fillStatus:
          "CAPACITY_LIMITED",
        quoteFailure: {
          errorName:
            "CurveSellCapacity",
          errorData: null,
          message:
            "Requested RHC WABIT sell exceeds the conservative executable active-curve redemption ceiling.",
        },
      },
    );
  }

  const result =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.wabit,
      ADDRESSES.rhc.weth,
      buy.netWabitOutRaw,
    );

  if (!result.ok) {
    return emptyCandidate(
      "BUY_ETH_SELL_RHC",
      source,
      requestedWethRaw,
      {
        actualWethSpentRaw:
          requestedWethRaw,
        acquiredWabitRaw:
          buy.netWabitOutRaw,
        sellWabitRequestedRaw:
          buy.netWabitOutRaw,
        buyVenue: "UniswapV2",
        sellVenue:
          rhcCurve.graduated
            ? "AMM"
            : "BondingCurve",
        fillStatus:
          "QUOTE_REVERTED",
        quoteFailure:
          result.failure,
      },
    );
  }

  const sell = result.quote;

  const unavailable =
    sell.venue === 0n ||
    sell.amountInUsedRaw === 0n;

  const partial =
    sell.refundAmountRaw > 0n;

  const fillStatus =
    unavailable
      ? "UNAVAILABLE"
      : partial
        ? "PARTIAL"
        : "FULL";

  const gross =
    fillStatus === "FULL"
      ? sell.amountOutRaw -
        requestedWethRaw
      : null;

  return {
    direction:
      "BUY_ETH_SELL_RHC",
    source,
    requestedWethRaw,
    actualWethSpentRaw:
      requestedWethRaw,
    acquiredWabitRaw:
      buy.netWabitOutRaw,
    sellWabitRequestedRaw:
      buy.netWabitOutRaw,
    sellWabitUsedRaw:
      sell.amountInUsedRaw,
    sellWabitRefundRaw:
      sell.refundAmountRaw,
    outputWethRaw:
      sell.amountOutRaw,
    buyVenue: "UniswapV2",
    sellVenue: sell.venueName,
    fillStatus,
    quoteFailure: null,
    grossProfitWethRaw: gross,
    grossProfitBps:
      gross == null
        ? null
        : signedBps(
            gross,
            requestedWethRaw,
          ),
    gasCostWethRaw: null,
    netProfitWethRaw: null,
    netProfitBps: null,
  };
}

async function buyRhcSellEth(
  requestedWethRaw: bigint,
  ethereum: EthereumVerification,
  source: OpportunitySource,
): Promise<OpportunityCandidate> {
  const result =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.weth,
      ADDRESSES.rhc.wabit,
      requestedWethRaw,
    );

  if (!result.ok) {
    return emptyCandidate(
      "BUY_RHC_SELL_ETH",
      source,
      requestedWethRaw,
      {
        buyVenue: "RHC",
        sellVenue: "UniswapV2",
        fillStatus:
          "QUOTE_REVERTED",
        quoteFailure:
          result.failure,
      },
    );
  }

  const buy = result.quote;

  if (
    buy.venue === 0n ||
    buy.amountInUsedRaw === 0n ||
    buy.amountOutRaw === 0n
  ) {
    return emptyCandidate(
      "BUY_RHC_SELL_ETH",
      source,
      requestedWethRaw,
      {
        buyVenue:
          buy.venueName,
        sellVenue:
          "UniswapV2",
      },
    );
  }

  const ethSell =
    modelEthereumSell(
      buy.amountOutRaw,
      ethereum,
    );

  const gross =
    ethSell.wethOutRaw -
    buy.amountInUsedRaw;

  return {
    direction:
      "BUY_RHC_SELL_ETH",
    source,
    requestedWethRaw,
    actualWethSpentRaw:
      buy.amountInUsedRaw,
    acquiredWabitRaw:
      buy.amountOutRaw,
    sellWabitRequestedRaw:
      buy.amountOutRaw,
    sellWabitUsedRaw:
      buy.amountOutRaw,
    sellWabitRefundRaw: 0n,
    outputWethRaw:
      ethSell.wethOutRaw,
    buyVenue: buy.venueName,
    sellVenue: "UniswapV2",
    fillStatus: "FULL",
    quoteFailure: null,
    grossProfitWethRaw: gross,
    grossProfitBps:
      signedBps(
        gross,
        buy.amountInUsedRaw,
      ),
    gasCostWethRaw: null,
    netProfitWethRaw: null,
    netProfitBps: null,
  };
}

async function evaluateDirection(
  direction: ArbDirection,
  requestedWethRaw: bigint,
  ethereum: EthereumVerification,
  rhcCurve: RhcCurveState,
  source: OpportunitySource,
): Promise<OpportunityCandidate> {
  if (
    direction ===
    "BUY_ETH_SELL_RHC"
  ) {
    return buyEthSellRhc(
      requestedWethRaw,
      ethereum,
      rhcCurve,
      source,
    );
  }

  return buyRhcSellEth(
    requestedWethRaw,
    ethereum,
    source,
  );
}

function parseConfiguredSweep(): bigint[] {
  const seen = new Set<string>();

  return config.sweepWeth
    .map((value) => {
      let raw: bigint;

      try {
        raw = parseEther(value);
      } catch {
        throw new Error(
          `Invalid SWEEP_WETH value: ${value}`,
        );
      }

      if (raw <= 0n) {
        throw new Error(
          `SWEEP_WETH values must be positive: ${value}`,
        );
      }

      return raw;
    })
    .filter((raw) => {
      const key = raw.toString();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
}

function capacityMatchedEthInput(
  ethereum: EthereumVerification,
  rhcCurve: RhcCurveState,
  ceiling: bigint,
): bigint | null {
  const capacity =
    rhcCurve.maxExecutableSellRaw;

  if (
    rhcCurve.graduated ||
    capacity == null ||
    capacity === 0n ||
    ceiling === 0n
  ) {
    return null;
  }

  if (
    modelEthereumBuy(
      ceiling,
      ethereum,
    ).netWabitOutRaw <= capacity
  ) {
    return null;
  }

  let low = 0n;
  let high = ceiling;

  const resolution = 1_000_000_000n;

  while (
    high - low > resolution
  ) {
    const mid =
      low +
      (high - low + 1n) /
        2n;

    const output =
      modelEthereumBuy(
        mid,
        ethereum,
      ).netWabitOutRaw;

    if (output <= capacity) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  return low > 0n
    ? low
    : null;
}

function profitValue(
  candidate: OpportunityCandidate,
): bigint {
  if (
    candidate.fillStatus !== "FULL" ||
    candidate.grossProfitWethRaw == null
  ) {
    return NEGATIVE_SENTINEL;
  }

  return candidate.grossProfitWethRaw;
}

function bestByGross(
  candidates: OpportunityCandidate[],
): OpportunityCandidate | null {
  const eligible =
    candidates.filter(
      (candidate) =>
        candidate.fillStatus === "FULL" &&
        candidate.grossProfitWethRaw != null,
    );

  if (eligible.length === 0) {
    return null;
  }

  return eligible.reduce((best, current) =>
    profitValue(current) >
    profitValue(best)
      ? current
      : best,
  );
}

function bestByNet(
  candidates: OpportunityCandidate[],
): OpportunityCandidate | null {
  const eligible =
    candidates.filter(
      (candidate) =>
        candidate.fillStatus === "FULL" &&
        candidate.netProfitWethRaw != null,
    );

  if (eligible.length === 0) {
    return null;
  }

  return eligible.reduce((best, current) =>
    (current.netProfitWethRaw ?? NEGATIVE_SENTINEL) >
    (best.netProfitWethRaw ?? NEGATIVE_SENTINEL)
      ? current
      : best,
  );
}

function optimizerBracket(
  coarse: OpportunityCandidate[],
  direction: ArbDirection,
): {
  lower: bigint;
  upper: bigint;
  best: OpportunityCandidate;
} | null {
  const eligible =
    coarse
      .filter(
        (candidate) =>
          candidate.direction === direction &&
          candidate.fillStatus === "FULL" &&
          candidate.grossProfitWethRaw != null,
      )
      .sort((a, b) =>
        a.requestedWethRaw <
        b.requestedWethRaw
          ? -1
          : a.requestedWethRaw >
              b.requestedWethRaw
            ? 1
            : 0,
      );

  if (eligible.length === 0) {
    return null;
  }

  let bestIndex = 0;

  for (
    let i = 1;
    i < eligible.length;
    i++
  ) {
    if (
      profitValue(eligible[i]) >
      profitValue(eligible[bestIndex])
    ) {
      bestIndex = i;
    }
  }

  const best =
    eligible[bestIndex];

  if (
    (best.grossProfitWethRaw ?? 0n) <=
    0n
  ) {
    return null;
  }

  const lower =
    bestIndex > 0
      ? eligible[bestIndex - 1]
          .requestedWethRaw
      : 1n;

  const upper =
    bestIndex + 1 < eligible.length
      ? eligible[bestIndex + 1]
          .requestedWethRaw
      : best.requestedWethRaw;

  if (upper <= lower) {
    return null;
  }

  return {
    lower,
    upper,
    best,
  };
}

async function optimizeGross(
  direction: ArbDirection,
  coarse: OpportunityCandidate[],
  ethereum: EthereumVerification,
  rhcCurve: RhcCurveState,
): Promise<{
  candidate: OpportunityCandidate | null;
  summary: OptimizerSummary;
}> {
  const bracket =
    optimizerBracket(
      coarse,
      direction,
    );

  if (
    bracket == null ||
    config.optimizerIterations === 0
  ) {
    return {
      candidate: null,
      summary: {
        ran: false,
        direction: null,
        iterations: 0,
        lowerBoundWethRaw: null,
        upperBoundWethRaw: null,
      },
    };
  }

  const originalLower =
    bracket.lower;
  const originalUpper =
    bracket.upper;

  let low =
    originalLower;
  let high =
    originalUpper;

  const cache =
    new Map<
      string,
      OpportunityCandidate
    >();

  const evaluate =
    async (
      amount: bigint,
    ): Promise<OpportunityCandidate> => {
      const key =
        amount.toString();

      const cached =
        cache.get(key);

      if (cached) {
        return cached;
      }

      const candidate =
        await evaluateDirection(
          direction,
          amount,
          ethereum,
          rhcCurve,
          "OPTIMIZED",
        );

      cache.set(
        key,
        candidate,
      );

      return candidate;
    };

  let iterations = 0;

  for (
    ;
    iterations <
      config.optimizerIterations &&
    high - low >
      config.optimizerResolutionWei;
    iterations++
  ) {
    const third =
      (high - low) / 3n;

    if (third === 0n) {
      break;
    }

    const m1 =
      low + third;
    const m2 =
      high - third;

    const c1 =
      await evaluate(m1);

    const c2 =
      await evaluate(m2);

    if (
      profitValue(c1) <
      profitValue(c2)
    ) {
      low = m1 + 1n;
    } else {
      high = m2 - 1n;
    }
  }

  const probes = new Set<string>();

  const addProbe = (
    amount: bigint,
  ): void => {
    if (
      amount >= originalLower &&
      amount <= originalUpper
    ) {
      probes.add(
        amount.toString(),
      );
    }
  };

  addProbe(low);
  addProbe(high);
  addProbe(
    low +
      (high - low) / 2n,
  );
  addProbe(
    bracket.best
      .requestedWethRaw,
  );

  const finalists: OpportunityCandidate[] = [
    bracket.best,
  ];

  for (const raw of probes) {
    finalists.push(
      await evaluate(
        BigInt(raw),
      ),
    );
  }

  const candidate =
    bestByGross(finalists);

  return {
    candidate:
      candidate &&
      candidate.source ===
        "OPTIMIZED"
        ? candidate
        : null,

    summary: {
      ran: true,
      direction,
      iterations,
      lowerBoundWethRaw:
        originalLower,
      upperBoundWethRaw:
        originalUpper,
    },
  };
}

export async function evaluateOpportunitySweep(
  ethereum: EthereumVerification,
): Promise<OpportunitySweep> {
  const [
    ethereumGasPriceWei,
    rhcGasPriceWei,
    rhcCurve,
  ] = await Promise.all([
    getEthereumGasPrice(),
    getRhcGasPrice(),
    getRhcCurveState(),
  ]);

  const gas: GasSnapshot = {
    ethereumGasPriceWei,
    rhcGasPriceWei,
  };

  const configured =
    parseConfiguredSweep();

  const ceiling =
    configured[
      configured.length - 1
    ];

  const capacityInput =
    capacityMatchedEthInput(
      ethereum,
      rhcCurve,
      ceiling,
    );

  const work: Array<{
    amount: bigint;
    source: OpportunitySource;
  }> = configured.map((amount) => ({
    amount,
    source: "SWEEP",
  }));

  if (
    capacityInput != null &&
    !configured.some(
      (value) =>
        value === capacityInput,
    )
  ) {
    work.push({
      amount: capacityInput,
      source:
        "RHC_SELL_CAPACITY",
    });

    work.sort((a, b) =>
      a.amount < b.amount
        ? -1
        : a.amount > b.amount
          ? 1
          : 0,
    );
  }

  const candidates: OpportunityCandidate[] = [];

  for (const item of work) {
    const directionA =
      await buyEthSellRhc(
        item.amount,
        ethereum,
        rhcCurve,
        item.source,
      );

    candidates.push(
      applyGas(directionA, gas),
    );

    if (
      item.source ===
      "RHC_SELL_CAPACITY"
    ) {
      continue;
    }

    const directionB =
      await buyRhcSellEth(
        item.amount,
        ethereum,
        item.source,
      );

    candidates.push(
      applyGas(directionB, gas),
    );
  }

  const coarseBest =
    bestByGross(candidates);

  let optimizer: OptimizerSummary = {
    ran: false,
    direction: null,
    iterations: 0,
    lowerBoundWethRaw: null,
    upperBoundWethRaw: null,
  };

  if (
    coarseBest &&
    (coarseBest.grossProfitWethRaw ?? 0n) >
      0n
  ) {
    const optimized =
      await optimizeGross(
        coarseBest.direction,
        candidates,
        ethereum,
        rhcCurve,
      );

    optimizer =
      optimized.summary;

    if (optimized.candidate) {
      candidates.push(
        applyGas(
          optimized.candidate,
          gas,
        ),
      );
    }
  }

  const gasModelConfigured =
    config.gasUnits.ethereumBuy != null &&
    config.gasUnits.ethereumSell != null &&
    config.gasUnits.rhcBuy != null &&
    config.gasUnits.rhcSell != null;

  return {
    generatedAt:
      new Date().toISOString(),
    gas,
    gasUnits: {
      ...config.gasUnits,
    },
    gasModelConfigured,
    rhcCurve,
    optimizer,
    candidates,
    bestGross:
      bestByGross(candidates),
    bestNet:
      gasModelConfigured
        ? bestByNet(candidates)
        : null,
    executionStatus:
      "NOT_SIMULATED",
  };
}
