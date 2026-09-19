import {
  Contract,
  JsonRpcProvider,
  id,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  RHC_CURVE_ABI,
  RHC_TRADE_ROUTER_ABI,
  SAME_NOTIONAL_WETH,
  venueName,
} from "../contracts.js";
import type {
  RhcCurveState,
  RhcExactInputQuote,
  RhcQuoteFailure,
  RhcVerification,
} from "../types.js";

const provider = new JsonRpcProvider(
  config.rhcRpcUrl,
  {
    chainId: ADDRESSES.rhc.chainId,
    name: "Robinhood Chain",
  },
  {
    staticNetwork: true,
    batchMaxCount: 1,
  },
);

const router = new Contract(
  ADDRESSES.rhc.tradeRouter,
  RHC_TRADE_ROUTER_ABI,
  provider,
);

const curve = new Contract(
  ADDRESSES.rhc.curve,
  RHC_CURVE_ABI,
  provider,
);

const KNOWN_ERROR_SELECTORS =
  new Map<string, string>([
    [
      id("InsufficientTokensSold()").slice(0, 10),
      "InsufficientTokensSold",
    ],
    [
      id("InsufficientQuoteReserve()").slice(0, 10),
      "InsufficientQuoteReserve",
    ],
    [
      id("InsufficientCurveLiquidity()").slice(0, 10),
      "InsufficientCurveLiquidity",
    ],
    [
      id("InsufficientInventory()").slice(0, 10),
      "InsufficientInventory",
    ],
    [
      id("MarketNotActive()").slice(0, 10),
      "MarketNotActive",
    ],
    [
      id("AmountInIsZero()").slice(0, 10),
      "AmountInIsZero",
    ],
  ]);

function extractRevertData(
  error: unknown,
): string | null {
  if (
    typeof error !== "object" ||
    error == null
  ) {
    return null;
  }

  const value =
    error as Record<string, unknown>;

  if (typeof value.data === "string") {
    return value.data;
  }

  const revert = value.revert;

  if (
    typeof revert === "object" &&
    revert != null
  ) {
    const nested =
      revert as Record<string, unknown>;

    if (typeof nested.data === "string") {
      return nested.data;
    }
  }

  const info = value.info;

  if (
    typeof info === "object" &&
    info != null
  ) {
    const nested =
      info as Record<string, unknown>;

    if (
      typeof nested.error === "object" &&
      nested.error != null
    ) {
      const inner =
        nested.error as Record<string, unknown>;

      if (typeof inner.data === "string") {
        return inner.data;
      }
    }
  }

  return null;
}

function quoteFailure(
  error: unknown,
): RhcQuoteFailure {
  const data = extractRevertData(error);

  const selector =
    data && data.length >= 10
      ? data.slice(0, 10)
      : null;

  const errorName =
    selector
      ? KNOWN_ERROR_SELECTORS.get(
          selector,
        ) ?? `Unknown(${selector})`
      : "Unknown";

  return {
    errorName,
    errorData: data,
    message:
      error instanceof Error
        ? error.message
        : String(error),
  };
}

/*
 * Mirror ReLaunchTradeRouter._maxExecutableSell() off-chain.
 *
 * Exact wei-level precision would require ~100 RPC round trips for WABIT's
 * current scale. A one-WABIT conservative resolution is economically
 * immaterial here and cuts the search to roughly 40 calls.
 *
 * Invariant on return:
 *     quoteSell(result) <= quoteReserve
 *
 * Therefore the returned amount is safe with respect to reserve solvency.
 */
async function maxExecutableCurveSell(
  tokensSoldRaw: bigint,
  quoteReserveRaw: bigint,
): Promise<{
  amountRaw: bigint;
  reserveLimited: boolean;
}> {
  if (
    tokensSoldRaw === 0n ||
    quoteReserveRaw === 0n
  ) {
    return {
      amountRaw: 0n,
      reserveLimited:
        tokensSoldRaw > 0n,
    };
  }

  const fullRawQuote =
    BigInt(
      await curve.quoteSell(
        tokensSoldRaw,
      ),
    );

  if (
    fullRawQuote <= quoteReserveRaw
  ) {
    return {
      amountRaw: tokensSoldRaw,
      reserveLimited: false,
    };
  }

  let low = 0n;
  let high = tokensSoldRaw;

  // One whole WABIT in 18-decimal raw units.
  const resolution = 1_000_000_000_000_000_000n;

  while (
    high - low > resolution
  ) {
    const mid =
      low +
      (high - low + 1n) /
        2n;

    const rawQuote =
      BigInt(
        await curve.quoteSell(mid),
      );

    if (
      rawQuote <= quoteReserveRaw
    ) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  // high may sit within one WABIT above the proven-safe low.
  // Keep the conservative proven-safe value.
  return {
    amountRaw: low,
    reserveLimited: true,
  };
}

export async function getRhcGasPrice(): Promise<bigint> {
  const raw = await provider.send(
    "eth_gasPrice",
    [],
  );

  return BigInt(raw);
}

export async function getRhcCurveState(): Promise<RhcCurveState> {
  const [
    activated,
    graduated,
    tokensSoldRawValue,
    quoteReserveRawValue,
  ] = await Promise.all([
    curve.activated(),
    curve.graduated(),
    curve.tokensSold(),
    curve.quoteReserve(),
  ]);

  const tokensSoldRaw =
    BigInt(tokensSoldRawValue);

  const quoteReserveRaw =
    BigInt(quoteReserveRawValue);

  if (Boolean(graduated)) {
    return {
      activated: Boolean(activated),
      graduated: true,
      tokensSoldRaw,
      quoteReserveRaw,
      maxExecutableSellRaw: null,
      capacityLimitedByReserve: false,
    };
  }

  const capacity =
    await maxExecutableCurveSell(
      tokensSoldRaw,
      quoteReserveRaw,
    );

  return {
    activated: Boolean(activated),
    graduated: false,
    tokensSoldRaw,
    quoteReserveRaw,
    maxExecutableSellRaw:
      capacity.amountRaw,
    capacityLimitedByReserve:
      capacity.reserveLimited,
  };
}

export async function quoteRhcExactInput(
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
): Promise<RhcExactInputQuote> {
  const quote =
    await router.quoteExactInput(
      tokenIn,
      tokenOut,
      amountInRaw,
    );

  const venue = BigInt(quote[0]);
  const amountInUsedRaw =
    BigInt(quote[1]);
  const amountOutRaw =
    BigInt(quote[2]);
  const refundAmountRaw =
    BigInt(quote[3]);

  if (
    amountInUsedRaw +
      refundAmountRaw !==
    amountInRaw
  ) {
    throw new Error(
      `RHC router quote does not reconcile input: requested=${amountInRaw.toString()} used=${amountInUsedRaw.toString()} refund=${refundAmountRaw.toString()}`,
    );
  }

  return {
    venue,
    venueName: venueName(venue),
    tokenIn,
    tokenOut,
    amountInRequestedRaw:
      amountInRaw,
    amountInUsedRaw,
    amountOutRaw,
    refundAmountRaw,
  };
}

export async function tryQuoteRhcExactInput(
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
): Promise<
  | {
      ok: true;
      quote: RhcExactInputQuote;
      failure: null;
    }
  | {
      ok: false;
      quote: null;
      failure: RhcQuoteFailure;
    }
> {
  try {
    return {
      ok: true,
      quote:
        await quoteRhcExactInput(
          tokenIn,
          tokenOut,
          amountInRaw,
        ),
      failure: null,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      quote: null,
      failure: quoteFailure(error),
    };
  }
}

export async function verifyRhcBuy(): Promise<RhcVerification> {
  const network =
    await provider.getNetwork();

  if (
    network.chainId !==
    BigInt(ADDRESSES.rhc.chainId)
  ) {
    throw new Error(
      `RHC RPC returned chain ID ${network.chainId.toString()}, expected ${ADDRESSES.rhc.chainId}`,
    );
  }

  const blockNumber =
    await provider.getBlockNumber();

  const quote =
    await quoteRhcExactInput(
      ADDRESSES.rhc.weth,
      ADDRESSES.rhc.wabit,
      SAME_NOTIONAL_WETH,
    );

  return {
    chainId: network.chainId,
    blockNumber,
    venue: quote.venue,
    venueName: quote.venueName,
    amountInRequestedRaw:
      quote.amountInRequestedRaw,
    amountInUsedRaw:
      quote.amountInUsedRaw,
    amountOutWabitRaw:
      quote.amountOutRaw,
    refundWethRaw:
      quote.refundAmountRaw,
  };
}
