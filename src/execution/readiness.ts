import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  ERC20_ABI,
} from "../contracts.js";

export interface ChainExecutionReadiness {
  nativeBalanceWei: bigint;
  wethBalanceRaw: bigint;
  wabitBalanceRaw: bigint;

  tradeAsset:
    | "WETH"
    | "WABIT";

  tradeAssetBalanceRaw: bigint;
  requiredTradeAssetRaw: bigint;
  tradeAssetShortfallRaw: bigint;
  tradeAssetReady: boolean;

  allowanceRaw: bigint;
  requiredAllowanceRaw: bigint;
  allowanceReady: boolean;

  requiredGasWei: bigint;
  nativeGasReady: boolean;

  tradeAssetRunway: bigint;
  gasRunway: bigint;
}

export interface ExecutionWalletReadiness {
  wallet: string;

  direction:
    "BUY_ETH_SELL_RHC";

  ethereum:
    ChainExecutionReadiness & {
      nativeWrapAvailableWei: bigint;
      wethWrapNeededRaw: bigint;
      canSelfFundRequiredWrap: boolean;
    };

  rhc:
    ChainExecutionReadiness;

  ready: boolean;
  blockers: string[];
}

function maxZero(
  value: bigint,
): bigint {
  return value > 0n
    ? value
    : 0n;
}

function runway(
  available: bigint,
  required: bigint,
): bigint {
  if (required <= 0n) {
    return 0n;
  }

  return available /
    required;
}

function ethereumProvider(): JsonRpcProvider {
  const request =
    new FetchRequest(
      config.ethereumRpcUrl,
    );

  if (
    config.ethereumRpcApiKey
  ) {
    request.setHeader(
      "x-api-key",
      config.ethereumRpcApiKey,
    );
  }

  return new JsonRpcProvider(
    request,
    ADDRESSES.ethereum.chainId,
    {
      staticNetwork: true,
      batchMaxCount: 1,
    },
  );
}

function rhcProvider(): JsonRpcProvider {
  return new JsonRpcProvider(
    config.rhcRpcUrl,
    {
      chainId:
        ADDRESSES.rhc.chainId,
      name:
        "Robinhood Chain",
    },
    {
      staticNetwork: true,
      batchMaxCount: 1,
    },
  );
}

async function readChainInventory(
  provider: JsonRpcProvider,
  wallet: string,
  wethAddress: string,
  wabitAddress: string,
  allowanceTokenAddress: string,
  allowanceSpender: string,
): Promise<{
  nativeBalanceWei: bigint;
  wethBalanceRaw: bigint;
  wabitBalanceRaw: bigint;
  allowanceRaw: bigint;
}> {
  const weth =
    new Contract(
      wethAddress,
      ERC20_ABI,
      provider,
    );

  const wabit =
    new Contract(
      wabitAddress,
      ERC20_ABI,
      provider,
    );

  const allowanceToken =
    allowanceTokenAddress
      .toLowerCase() ===
    wethAddress.toLowerCase()
      ? weth
      : wabit;

  const [
    nativeBalanceWei,
    wethBalanceRaw,
    wabitBalanceRaw,
    allowanceRaw,
  ] =
    await Promise.all([
      provider.getBalance(
        wallet,
      ),
      weth.balanceOf(
        wallet,
      ),
      wabit.balanceOf(
        wallet,
      ),
      allowanceToken.allowance(
        wallet,
        allowanceSpender,
      ),
    ]);

  return {
    nativeBalanceWei,
    wethBalanceRaw:
      BigInt(wethBalanceRaw),
    wabitBalanceRaw:
      BigInt(wabitBalanceRaw),
    allowanceRaw:
      BigInt(allowanceRaw),
  };
}

export async function evaluateExecutionWalletReadiness(
  requirements: {
    ethereumWethRequiredRaw:
      bigint;

    rhcWabitRequiredRaw:
      bigint;

    ethereumGasUnits:
      bigint;

    rhcGasUnits:
      bigint;

    ethereumGasPriceWei:
      bigint;

    rhcGasPriceWei:
      bigint;
  },
): Promise<ExecutionWalletReadiness> {
  /*
   * Phase 5C deliberately watches the existing DaWab dev/genesis wallet.
   * It is a public address only. No private key or signer exists in the
   * searcher.
   *
   * If execution later moves to a dedicated wallet, this address must become
   * explicit configuration and the signer address must be verified against it.
   */
  const wallet =
    config.executorAddress ??
    ADDRESSES.rhc
      .wabitInventorySource;

  const ethProvider =
    ethereumProvider();

  const rhc =
    rhcProvider();

  try {
    const [
      ethereumInventory,
      rhcInventory,
    ] =
      await Promise.all([
        readChainInventory(
          ethProvider,
          wallet,
          ADDRESSES.ethereum
            .weth,
          ADDRESSES.ethereum
            .wabit,
          ADDRESSES.ethereum
            .weth,
          ADDRESSES.ethereum
            .uniswapV2Router02,
        ),

        readChainInventory(
          rhc,
          wallet,
          ADDRESSES.rhc.weth,
          ADDRESSES.rhc.wabit,
          ADDRESSES.rhc.wabit,
          ADDRESSES.rhc
            .tradeRouter,
        ),
      ]);

    const ethereumGasRequiredWei =
      requirements
        .ethereumGasUnits *
      requirements
        .ethereumGasPriceWei;

    const rhcGasRequiredWei =
      requirements
        .rhcGasUnits *
      requirements
        .rhcGasPriceWei;

    const ethWethShortfall =
      maxZero(
        requirements
          .ethereumWethRequiredRaw -
        ethereumInventory
          .wethBalanceRaw,
      );

    const rhcWabitShortfall =
      maxZero(
        requirements
          .rhcWabitRequiredRaw -
        rhcInventory
          .wabitBalanceRaw,
      );

    /*
     * Native ETH that could be wrapped while still retaining enough native
     * ETH for one modeled Ethereum transaction.
     */
    const nativeWrapAvailableWei =
      maxZero(
        ethereumInventory
          .nativeBalanceWei -
        ethereumGasRequiredWei,
      );

    const ethereumTradeReady =
      ethWethShortfall === 0n;

    const ethereumAllowanceReady =
      ethereumInventory
        .allowanceRaw >=
      requirements
        .ethereumWethRequiredRaw;

    const ethereumGasReady =
      ethereumInventory
        .nativeBalanceWei >=
      ethereumGasRequiredWei;

    const rhcTradeReady =
      rhcWabitShortfall === 0n;

    const rhcAllowanceReady =
      rhcInventory
        .allowanceRaw >=
      requirements
        .rhcWabitRequiredRaw;

    const rhcGasReady =
      rhcInventory
        .nativeBalanceWei >=
      rhcGasRequiredWei;

    const blockers: string[] =
      [];

    if (!ethereumTradeReady) {
      if (
        nativeWrapAvailableWei >=
        ethWethShortfall
      ) {
        blockers.push(
          "Ethereum WETH is short, but the wallet has enough native ETH to wrap the shortfall while preserving one modeled gas budget.",
        );
      } else {
        blockers.push(
          "Ethereum WETH is insufficient and current native ETH cannot fully cover both the WETH shortfall and one modeled gas budget.",
        );
      }
    }

    if (
      !ethereumAllowanceReady
    ) {
      blockers.push(
        "Ethereum WETH allowance to Uniswap V2 Router02 is insufficient.",
      );
    }

    if (!ethereumGasReady) {
      blockers.push(
        "Ethereum native ETH gas balance is insufficient for one modeled trade.",
      );
    }

    if (!rhcTradeReady) {
      blockers.push(
        "RHC WABIT inventory is insufficient for the protected sell leg.",
      );
    }

    if (!rhcAllowanceReady) {
      blockers.push(
        "RHC WABIT allowance to ReLaunchTradeRouter is insufficient.",
      );
    }

    if (!rhcGasReady) {
      blockers.push(
        "RHC native ETH gas balance is insufficient for one modeled trade.",
      );
    }

    const ready =
      ethereumTradeReady &&
      ethereumAllowanceReady &&
      ethereumGasReady &&
      rhcTradeReady &&
      rhcAllowanceReady &&
      rhcGasReady;

    return {
      wallet,
      direction:
        "BUY_ETH_SELL_RHC",

      ethereum: {
        nativeBalanceWei:
          ethereumInventory
            .nativeBalanceWei,

        wethBalanceRaw:
          ethereumInventory
            .wethBalanceRaw,

        wabitBalanceRaw:
          ethereumInventory
            .wabitBalanceRaw,

        tradeAsset: "WETH",

        tradeAssetBalanceRaw:
          ethereumInventory
            .wethBalanceRaw,

        requiredTradeAssetRaw:
          requirements
            .ethereumWethRequiredRaw,

        tradeAssetShortfallRaw:
          ethWethShortfall,

        tradeAssetReady:
          ethereumTradeReady,

        allowanceRaw:
          ethereumInventory
            .allowanceRaw,

        requiredAllowanceRaw:
          requirements
            .ethereumWethRequiredRaw,

        allowanceReady:
          ethereumAllowanceReady,

        requiredGasWei:
          ethereumGasRequiredWei,

        nativeGasReady:
          ethereumGasReady,

        tradeAssetRunway:
          runway(
            ethereumInventory
              .wethBalanceRaw,
            requirements
              .ethereumWethRequiredRaw,
          ),

        gasRunway:
          runway(
            ethereumInventory
              .nativeBalanceWei,
            ethereumGasRequiredWei,
          ),

        nativeWrapAvailableWei,

        wethWrapNeededRaw:
          ethWethShortfall,

        canSelfFundRequiredWrap:
          ethWethShortfall ===
            0n ||
          nativeWrapAvailableWei >=
            ethWethShortfall,
      },

      rhc: {
        nativeBalanceWei:
          rhcInventory
            .nativeBalanceWei,

        wethBalanceRaw:
          rhcInventory
            .wethBalanceRaw,

        wabitBalanceRaw:
          rhcInventory
            .wabitBalanceRaw,

        tradeAsset: "WABIT",

        tradeAssetBalanceRaw:
          rhcInventory
            .wabitBalanceRaw,

        requiredTradeAssetRaw:
          requirements
            .rhcWabitRequiredRaw,

        tradeAssetShortfallRaw:
          rhcWabitShortfall,

        tradeAssetReady:
          rhcTradeReady,

        allowanceRaw:
          rhcInventory
            .allowanceRaw,

        requiredAllowanceRaw:
          requirements
            .rhcWabitRequiredRaw,

        allowanceReady:
          rhcAllowanceReady,

        requiredGasWei:
          rhcGasRequiredWei,

        nativeGasReady:
          rhcGasReady,

        tradeAssetRunway:
          runway(
            rhcInventory
              .wabitBalanceRaw,
            requirements
              .rhcWabitRequiredRaw,
          ),

        gasRunway:
          runway(
            rhcInventory
              .nativeBalanceWei,
            rhcGasRequiredWei,
          ),
      },

      ready,
      blockers,
    };
  } finally {
    ethProvider.destroy();
    rhc.destroy();
  }
}
