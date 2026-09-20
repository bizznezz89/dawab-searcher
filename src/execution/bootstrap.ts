import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
} from "ethers";
import {
  type ChildProcess,
  spawn,
} from "node:child_process";
import {
  existsSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

import { config } from "../config.js";
import {
  ADDRESSES,
  ERC20_ABI,
  WETH_ABI,
} from "../contracts.js";
import type {
  ExecutionWalletReadiness,
} from "./readiness.js";

interface ForkHandle {
  process: ChildProcess;
  provider: JsonRpcProvider;
  stderr: () => string;
}

export interface BootstrapActionSimulation {
  needed: boolean;
  simulated: boolean;
  gasUsed: bigint;
  gasCostWei: bigint;
  detail: string;
}

export interface WalletBootstrapSimulation {
  wallet: string;

  ethereumWrap:
    BootstrapActionSimulation & {
      amountRaw: bigint;
    };

  ethereumApproval:
    BootstrapActionSimulation;

  rhcApproval:
    BootstrapActionSimulation;

  ethereumNativeRequiredWei:
    bigint;

  rhcNativeRequiredWei:
    bigint;

  ethereumNativeSufficient:
    boolean;

  rhcNativeSufficient:
    boolean;

  postBootstrapEthereumWethRaw:
    bigint;

  postBootstrapEthereumAllowanceRaw:
    bigint;

  postBootstrapRhcAllowanceRaw:
    bigint;

  simulatedReady:
    boolean;

  blockers: string[];
}

const ETH_PORT =
  18547;

const RHC_APPROVE_MAX_INTRINSIC_GAS =
  21_000n +
  68n * 16n;

function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    (resolvePromise) =>
      setTimeout(
        resolvePromise,
        ms,
      ),
  );
}

async function waitForFork(
  child: ChildProcess,
  url: string,
  stderr: () => string,
): Promise<void> {
  const deadline =
    Date.now() +
    20_000;

  while (
    Date.now() <
    deadline
  ) {
    if (
      child.exitCode != null
    ) {
      throw new Error(
        `Ethereum bootstrap Anvil exited before readiness: ${stderr()}`,
      );
    }

    try {
      const response =
        await fetch(
          url,
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json",
            },
            body:
              JSON.stringify(
                {
                  jsonrpc:
                    "2.0",
                  id: 1,
                  method:
                    "eth_chainId",
                  params: [],
                },
              ),
            signal:
              AbortSignal.timeout(
                1_000,
              ),
          },
        );

      if (response.ok) {
        const body =
          (await response.json()) as {
            result?: string;
          };

        if (body.result) {
          return;
        }
      }
    } catch {
      // Fork not ready yet.
    }

    await sleep(250);
  }

  const detail =
    stderr();

  throw new Error(
    `Timed out waiting for Ethereum bootstrap fork${
      detail
        ? `: ${detail}`
        : ""
    }`,
  );
}

async function startEthereumFork(): Promise<ForkHandle> {
  if (
    config.ethereumRpcApiKey &&
    /(?:^|\/\/)[^/]*tatum\.io(?:\/|$)/i.test(
      config.ethereumRpcUrl,
    )
  ) {
    throw new Error(
      "Bootstrap simulation cannot forward a separate Tatum x-api-key header through Anvil.",
    );
  }

  const child =
    spawn(
      "anvil",
      [
        "--port",
        String(
          ETH_PORT,
        ),
        "--chain-id",
        String(
          ADDRESSES.ethereum
            .chainId,
        ),
        "--fork-url",
        config.ethereumRpcUrl,
        "--silent",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "pipe",
        ],
        windowsHide: true,
      },
    );

  let stderrBuffer = "";

  child.stderr?.on(
    "data",
    (chunk: Buffer) => {
      stderrBuffer +=
        chunk.toString(
          "utf8",
        );

      if (
        stderrBuffer.length >
        8_000
      ) {
        stderrBuffer =
          stderrBuffer.slice(
            -8_000,
          );
      }
    },
  );

  const provider =
    new JsonRpcProvider(
      `http://127.0.0.1:${ETH_PORT}`,
      {
        chainId:
          ADDRESSES.ethereum
            .chainId,
        name:
          "Ethereum Bootstrap Fork",
      },
      {
        staticNetwork:
          true,
        batchMaxCount: 1,
      },
    );

  const handle = {
    process: child,
    provider,
    stderr: () =>
      stderrBuffer.trim(),
  };

  try {
    await waitForFork(
      child,
      `http://127.0.0.1:${ETH_PORT}`,
      handle.stderr,
    );

    return handle;
  } catch (error) {
    child.kill();
    provider.destroy();

    throw error;
  }
}

async function stopFork(
  fork: ForkHandle,
): Promise<void> {
  fork.provider.destroy();

  if (
    fork.process.exitCode ==
    null
  ) {
    fork.process.kill();
  }

  await sleep(150);
}

async function simulateEthereumBootstrap(
  readiness:
    ExecutionWalletReadiness,
  ethereumGasPriceWei:
    bigint,
): Promise<{
  wrap:
    BootstrapActionSimulation & {
      amountRaw: bigint;
    };

  approval:
    BootstrapActionSimulation;

  postWethRaw: bigint;
  postAllowanceRaw: bigint;
}> {
  const wrapNeeded =
    readiness.ethereum
      .wethWrapNeededRaw >
    0n;

  const approvalNeeded =
    !readiness.ethereum
      .allowanceReady;

  if (
    !wrapNeeded &&
    !approvalNeeded
  ) {
    return {
      wrap: {
        needed: false,
        simulated: true,
        amountRaw: 0n,
        gasUsed: 0n,
        gasCostWei: 0n,
        detail:
          "Ethereum WETH inventory already sufficient.",
      },
      approval: {
        needed: false,
        simulated: true,
        gasUsed: 0n,
        gasCostWei: 0n,
        detail:
          "Ethereum WETH allowance already sufficient.",
      },
      postWethRaw:
        readiness.ethereum
          .wethBalanceRaw,
      postAllowanceRaw:
        readiness.ethereum
          .allowanceRaw,
    };
  }

  const fork =
    await startEthereumFork();

  try {
    const wallet =
      readiness.wallet;

    await fork.provider.send(
      "anvil_impersonateAccount",
      [wallet],
    );

    const signer =
      await fork.provider.getSigner(
        wallet,
      );

    const weth =
      new Contract(
        ADDRESSES.ethereum
          .weth,
        WETH_ABI,
        signer,
      );

    let wrapGasUsed = 0n;

    if (wrapNeeded) {
      const tx =
        await weth.deposit(
          {
            value:
              readiness.ethereum
                .wethWrapNeededRaw,
          },
        );

      const receipt =
        await tx.wait();

      if (!receipt) {
        throw new Error(
          "Ethereum fork WETH wrap produced no receipt",
        );
      }

      wrapGasUsed =
        receipt.gasUsed;
    }

    let approvalGasUsed =
      0n;

    if (approvalNeeded) {
      const tx =
        await weth.approve(
          ADDRESSES.ethereum
            .uniswapV2Router02,
          MaxUint256,
        );

      const receipt =
        await tx.wait();

      if (!receipt) {
        throw new Error(
          "Ethereum fork WETH approval produced no receipt",
        );
      }

      approvalGasUsed =
        receipt.gasUsed;
    }

    const [
      postWeth,
      postAllowance,
    ] =
      await Promise.all([
        weth.balanceOf(
          wallet,
        ),
        weth.allowance(
          wallet,
          ADDRESSES.ethereum
            .uniswapV2Router02,
        ),
      ]);

    await fork.provider.send(
      "anvil_stopImpersonatingAccount",
      [wallet],
    );

    return {
      wrap: {
        needed:
          wrapNeeded,
        simulated: true,
        amountRaw:
          readiness.ethereum
            .wethWrapNeededRaw,
        gasUsed:
          wrapGasUsed,
        gasCostWei:
          wrapGasUsed *
          ethereumGasPriceWei,
        detail:
          wrapNeeded
            ? "Fork-simulated native ETH -> WETH deposit succeeded."
            : "Ethereum WETH inventory already sufficient.",
      },

      approval: {
        needed:
          approvalNeeded,
        simulated: true,
        gasUsed:
          approvalGasUsed,
        gasCostWei:
          approvalGasUsed *
          ethereumGasPriceWei,
        detail:
          approvalNeeded
            ? "Fork-simulated WETH -> Router02 approval succeeded."
            : "Ethereum WETH allowance already sufficient.",
      },

      postWethRaw:
        BigInt(postWeth),

      postAllowanceRaw:
        BigInt(
          postAllowance,
        ),
    };
  } finally {
    await stopFork(fork);
  }
}

function forgeProjectRoot(): string {
  return resolve(
    process.cwd(),
    "forge",
    "rhc-bootstrap",
  );
}

function parseForgeUint(
  output: string,
  key: string,
): bigint {
  const match =
    output.match(
      new RegExp(
        `${key}:\\s*(\\d+)`,
      ),
    );

  if (!match?.[1]) {
    throw new Error(
      `RHC bootstrap Forge simulation did not emit ${key}`,
    );
  }

  return BigInt(
    match[1],
  );
}

async function simulateRhcApproval(
  readiness:
    ExecutionWalletReadiness,
  rhcGasPriceWei:
    bigint,
): Promise<{
  approval:
    BootstrapActionSimulation;

  postAllowanceRaw:
    bigint;
}> {
  if (
    readiness.rhc
      .allowanceReady
  ) {
    return {
      approval: {
        needed: false,
        simulated: true,
        gasUsed: 0n,
        gasCostWei: 0n,
        detail:
          "RHC WABIT allowance already sufficient.",
      },

      postAllowanceRaw:
        readiness.rhc
          .allowanceRaw,
    };
  }

  const cwd =
    forgeProjectRoot();

  if (
    !existsSync(
      resolve(
        cwd,
        "foundry.toml",
      ),
    )
  ) {
    throw new Error(
      "RHC bootstrap Forge project is missing at forge/rhc-bootstrap",
    );
  }

  const output =
    await new Promise<string>(
      (
        resolvePromise,
        rejectPromise,
      ) => {
        const child =
          spawn(
            "forge",
            [
              "test",
              "--fork-url",
              config.rhcRpcUrl,
              "--match-contract",
              "RhcBootstrapSimulation",
              "--match-test",
              "testSimulateApproval",
              "-vv",
              "--color",
              "never",
            ],
            {
              cwd,
              env: {
                ...process.env,
                DAWAB_RHC_REQUIRED_WABIT:
                  readiness.rhc
                    .requiredTradeAssetRaw
                    .toString(),
              },
              stdio: [
                "ignore",
                "pipe",
                "pipe",
              ],
              windowsHide:
                true,
            },
          );

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer =
          setTimeout(
            () => {
              if (settled) {
                return;
              }

              settled = true;
              child.kill();

              rejectPromise(
                new Error(
                  "RHC bootstrap Forge simulation timed out after 90s",
                ),
              );
            },
            90_000,
          );

        child.stdout?.on(
          "data",
          (chunk: Buffer) => {
            stdout +=
              chunk.toString(
                "utf8",
              );
          },
        );

        child.stderr?.on(
          "data",
          (chunk: Buffer) => {
            stderr +=
              chunk.toString(
                "utf8",
              );
          },
        );

        child.on(
          "error",
          (error) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(
              timer,
            );

            rejectPromise(
              new Error(
                `Unable to launch Forge RHC bootstrap simulation: ${error.message}`,
              ),
            );
          },
        );

        child.on(
          "close",
          (code) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(
              timer,
            );

            const combined =
              `${stdout}\n${stderr}`;

            if (code !== 0) {
              const tail =
                combined
                  .trim()
                  .split(
                    /\r?\n/,
                  )
                  .slice(-30)
                  .join("\n");

              rejectPromise(
                new Error(
                  `RHC bootstrap Forge simulation failed${
                    tail
                      ? `:\n${tail}`
                      : ""
                  }`,
                ),
              );

              return;
            }

            resolvePromise(
              combined,
            );
          },
        );
      },
    );

  const callGasUsed =
    parseForgeUint(
      output,
      "DAWAB_RHC_APPROVE_CALL_GAS",
    );

  const postAllowanceRaw =
    parseForgeUint(
      output,
      "DAWAB_RHC_POST_ALLOWANCE",
    );

  const modeledGasUsed =
    callGasUsed +
    RHC_APPROVE_MAX_INTRINSIC_GAS;

  return {
    approval: {
      needed: true,
      simulated: true,
      gasUsed:
        modeledGasUsed,
      gasCostWei:
        modeledGasUsed *
        rhcGasPriceWei,
      detail:
        "Forge-fork WABIT -> TradeRouter approval succeeded.",
    },

    postAllowanceRaw,
  };
}

export async function simulateWalletBootstrap(
  readiness:
    ExecutionWalletReadiness,
  gas: {
    ethereumGasPriceWei:
      bigint;
    rhcGasPriceWei:
      bigint;
  },
): Promise<WalletBootstrapSimulation> {
  const [
    ethereum,
    rhc,
  ] =
    await Promise.all([
      simulateEthereumBootstrap(
        readiness,
        gas
          .ethereumGasPriceWei,
      ),

      simulateRhcApproval(
        readiness,
        gas.rhcGasPriceWei,
      ),
    ]);

  const ethereumBootstrapGasWei =
    ethereum.wrap
      .gasCostWei +
    ethereum.approval
      .gasCostWei;

  const rhcBootstrapGasWei =
    rhc.approval
      .gasCostWei;

  /*
   * Preserve enough native gas for both:
   *   bootstrap transaction(s)
   *   + one protected trade transaction.
   *
   * WETH wrapping additionally consumes the wrapped amount itself.
   */
  const ethereumNativeRequiredWei =
    readiness.ethereum
      .wethWrapNeededRaw +
    ethereumBootstrapGasWei +
    readiness.ethereum
      .requiredGasWei;

  const rhcNativeRequiredWei =
    rhcBootstrapGasWei +
    readiness.rhc
      .requiredGasWei;

  const ethereumNativeSufficient =
    readiness.ethereum
      .nativeBalanceWei >=
    ethereumNativeRequiredWei;

  const rhcNativeSufficient =
    readiness.rhc
      .nativeBalanceWei >=
    rhcNativeRequiredWei;

  const postEthereumWethReady =
    ethereum.postWethRaw >=
    readiness.ethereum
      .requiredTradeAssetRaw;

  const postEthereumAllowanceReady =
    ethereum.postAllowanceRaw >=
    readiness.ethereum
      .requiredAllowanceRaw;

  const postRhcAllowanceReady =
    rhc.postAllowanceRaw >=
    readiness.rhc
      .requiredAllowanceRaw;

  const blockers: string[] =
    [];

  if (
    !ethereumNativeSufficient
  ) {
    blockers.push(
      "Ethereum native ETH cannot cover the required WETH wrap, bootstrap gas, and one modeled trade gas budget.",
    );
  }

  if (!rhcNativeSufficient) {
    blockers.push(
      "RHC native ETH cannot cover bootstrap approval gas plus one modeled trade gas budget.",
    );
  }

  if (
    !postEthereumWethReady
  ) {
    blockers.push(
      "Ethereum WETH remains insufficient after fork-simulated bootstrap.",
    );
  }

  if (
    !postEthereumAllowanceReady
  ) {
    blockers.push(
      "Ethereum WETH allowance remains insufficient after fork-simulated bootstrap.",
    );
  }

  if (
    !readiness.rhc
      .tradeAssetReady
  ) {
    blockers.push(
      "RHC WABIT inventory is insufficient; bootstrap cannot manufacture trade inventory.",
    );
  }

  if (
    !postRhcAllowanceReady
  ) {
    blockers.push(
      "RHC WABIT allowance remains insufficient after fork-simulated bootstrap.",
    );
  }

  const simulatedReady =
    ethereumNativeSufficient &&
    rhcNativeSufficient &&
    postEthereumWethReady &&
    postEthereumAllowanceReady &&
    readiness.rhc
      .tradeAssetReady &&
    postRhcAllowanceReady;

  return {
    wallet:
      readiness.wallet,

    ethereumWrap:
      ethereum.wrap,

    ethereumApproval:
      ethereum.approval,

    rhcApproval:
      rhc.approval,

    ethereumNativeRequiredWei,

    rhcNativeRequiredWei,

    ethereumNativeSufficient,

    rhcNativeSufficient,

    postBootstrapEthereumWethRaw:
      ethereum.postWethRaw,

    postBootstrapEthereumAllowanceRaw:
      ethereum.postAllowanceRaw,

    postBootstrapRhcAllowanceRaw:
      rhc.postAllowanceRaw,

    simulatedReady,

    blockers,
  };
}
