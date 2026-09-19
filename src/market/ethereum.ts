import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  getAddress,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  BPS_DENOMINATOR,
  SAME_NOTIONAL_WETH,
  UNISWAP_V2_PAIR_ABI,
  V2_FEE_DENOMINATOR,
  V2_FEE_NUMERATOR,
  WABIT_TRANSFER_BURN_BPS,
} from "../contracts.js";
import type {
  EthereumBuyModel,
  EthereumSellModel,
  EthereumVerification,
} from "../types.js";

const ethereumRequest = new FetchRequest(
  config.ethereumRpcUrl,
);

if (config.ethereumRpcApiKey) {
  ethereumRequest.setHeader(
    "x-api-key",
    config.ethereumRpcApiKey,
  );
}

const provider = new JsonRpcProvider(
  ethereumRequest,
  ADDRESSES.ethereum.chainId,
  {
    staticNetwork: true,
    batchMaxCount: 1,
  },
);

const pair = new Contract(
  ADDRESSES.ethereum.wabitWethPair,
  UNISWAP_V2_PAIR_ABI,
  provider,
);

function v2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n
  ) {
    return 0n;
  }

  const amountInWithFee =
    amountIn * V2_FEE_NUMERATOR;

  const numerator =
    amountInWithFee * reserveOut;

  const denominator =
    reserveIn * V2_FEE_DENOMINATOR +
    amountInWithFee;

  return numerator / denominator;
}

function applyWabitTransferBurn(
  amount: bigint,
): {
  burn: bigint;
  net: bigint;
} {
  const burn =
    (amount * WABIT_TRANSFER_BURN_BPS) /
    BPS_DENOMINATOR;

  return {
    burn,
    net: amount - burn,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

export function modelEthereumBuy(
  amountInWethRaw: bigint,
  market: Pick<
    EthereumVerification,
    "wethReserveRaw" | "wabitReserveRaw"
  >,
): EthereumBuyModel {
  const grossWabitOutRaw =
    v2AmountOut(
      amountInWethRaw,
      market.wethReserveRaw,
      market.wabitReserveRaw,
    );

  // Pair -> trader transfer burns 1 bp.
  const transfer =
    applyWabitTransferBurn(
      grossWabitOutRaw,
    );

  return {
    inputWethRaw: amountInWethRaw,
    grossWabitOutRaw,
    transferBurnRaw: transfer.burn,
    netWabitOutRaw: transfer.net,
  };
}

export function modelEthereumSell(
  amountInWabitRaw: bigint,
  market: Pick<
    EthereumVerification,
    "wethReserveRaw" | "wabitReserveRaw"
  >,
): EthereumSellModel {
  // Trader -> pair transfer burns 1 bp, so the pair
  // receives less than the nominal WABIT input.
  const transfer =
    applyWabitTransferBurn(
      amountInWabitRaw,
    );

  const wethOutRaw =
    v2AmountOut(
      transfer.net,
      market.wabitReserveRaw,
      market.wethReserveRaw,
    );

  return {
    inputWabitRaw: amountInWabitRaw,
    transferBurnRaw: transfer.burn,
    amountReceivedByPairRaw: transfer.net,
    wethOutRaw,
  };
}

export async function getEthereumGasPrice(): Promise<bigint> {
  const raw = await provider.send(
    "eth_gasPrice",
    [],
  );

  return BigInt(raw);
}

export async function verifyEthereumBuy(): Promise<EthereumVerification> {
  const network = await provider.getNetwork();

  if (
    network.chainId !==
    BigInt(ADDRESSES.ethereum.chainId)
  ) {
    throw new Error(
      `Ethereum RPC returned chain ID ${network.chainId.toString()}, expected ${ADDRESSES.ethereum.chainId}`,
    );
  }

  const blockNumber =
    await provider.getBlockNumber();

  await sleep(375);

  const token0 = getAddress(
    await pair.token0(),
  );

  await sleep(375);

  const token1 = getAddress(
    await pair.token1(),
  );

  await sleep(375);

  const factory = getAddress(
    await pair.factory(),
  );

  await sleep(375);

  const reserves =
    await pair.getReserves();

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);

  let wethReserveRaw: bigint;
  let wabitReserveRaw: bigint;

  if (
    token0 === ADDRESSES.ethereum.weth &&
    token1 === ADDRESSES.ethereum.wabit
  ) {
    wethReserveRaw = reserve0;
    wabitReserveRaw = reserve1;
  } else if (
    token1 === ADDRESSES.ethereum.weth &&
    token0 === ADDRESSES.ethereum.wabit
  ) {
    wethReserveRaw = reserve1;
    wabitReserveRaw = reserve0;
  } else {
    throw new Error(
      `Unexpected WABIT/WETH pair tokens: ${token0}/${token1}`,
    );
  }

  const market = {
    wethReserveRaw,
    wabitReserveRaw,
  };

  const buy = modelEthereumBuy(
    SAME_NOTIONAL_WETH,
    market,
  );

  return {
    chainId: network.chainId,
    blockNumber,

    pair: ADDRESSES.ethereum.wabitWethPair,
    factory,
    canonicalUniswapV2Factory:
      factory ===
      ADDRESSES.ethereum.uniswapV2Factory,

    token0,
    token1,

    wethReserveRaw,
    wabitReserveRaw,

    amountInWethRaw: buy.inputWethRaw,
    grossWabitOutRaw:
      buy.grossWabitOutRaw,
    transferBurnRaw:
      buy.transferBurnRaw,
    netWabitOutRaw:
      buy.netWabitOutRaw,
  };
}
