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

import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  formatEther,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  ERC20_ABI,
  UNISWAP_V2_ROUTER02_ABI,
  WETH_ABI,
} from "../contracts.js";
import type {
  OpportunityCandidate,
  OpportunitySweep,
} from "../types.js";

interface ForkHandle {
  process: ChildProcess;
  provider: JsonRpcProvider;
  url: string;
  stderr: () => string;
}

interface SimulatedLeg {
  chain: "Ethereum" | "RHC";
  engine: "Anvil" | "Forge";
  action: string;

  /*
   * Ethereum:
   *   estimatedGas = eth_estimateGas on the Anvil fork
   *   gasUsed      = fork transaction receipt gasUsed
   *
   * RHC:
   *   estimatedGas = Forge-measured router call gas
   *   gasUsed      = conservative modeled transaction gas:
   *                  router call gas + max intrinsic calldata gas
   */
  estimatedGas: bigint;
  gasUsed: bigint;

  expectedOutputRaw: bigint;
  actualOutputRaw: bigint;
  outputDifferenceBps: number;
}

interface ForgeRhcResult {
  routerCallGasUsed: bigint;
  quotedWethOutRaw: bigint;
  actualWethOutRaw: bigint;
}

export interface Phase4Simulation {
  candidate: OpportunityCandidate;

  ethereum: SimulatedLeg;
  rhc: SimulatedLeg;

  ethereumGasCostWethRaw: bigint;
  rhcGasCostWethRaw: bigint;
  totalGasCostWethRaw: bigint;

  grossProfitWethRaw: bigint;
  netProfitWethRaw: bigint;
  netProfitBps: number;

  executionStatus: "FORK_SIMULATED";
}

const ETH_PORT = 18545;

/*
 * Direct EOA transaction intrinsic gas:
 *
 *   21,000 base
 * + at most 16 gas for every calldata byte.
 *
 * swapExactInput(address,address,uint256,uint256,address,uint256)
 * is 4 selector bytes + 6 ABI words = 196 bytes.
 *
 * Using the all-nonzero maximum deliberately makes the RHC transaction-gas
 * figure conservative. The actual calldata contains zero bytes and will
 * normally cost slightly less intrinsic gas.
 */
const RHC_MAX_INTRINSIC_GAS =
  21_000n +
  196n * 16n;

function sleep(
  ms: number,
): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(
      resolvePromise,
      ms,
    ),
  );
}

function absolute(
  value: bigint,
): bigint {
  return value < 0n
    ? -value
    : value;
}

function differenceBps(
  actual: bigint,
  expected: bigint,
): number {
  if (expected === 0n) {
    return actual === 0n
      ? 0
      : Number.POSITIVE_INFINITY;
  }

  const diff =
    absolute(actual - expected);

  const scaled =
    (diff * 1_000_000n) /
    expected;

  return Number(scaled) / 100;
}

function signedBps(
  value: bigint,
  base: bigint,
): number {
  if (base <= 0n) {
    return 0;
  }

  const scaled =
    (value * 1_000_000n) /
    base;

  return Number(scaled) / 100;
}

async function waitForFork(
  process: ChildProcess,
  url: string,
  stderr: () => string,
): Promise<void> {
  const deadline =
    Date.now() + 20_000;

  while (
    Date.now() <
    deadline
  ) {
    if (
      process.exitCode != null
    ) {
      throw new Error(
        `Anvil exited before becoming ready: ${stderr()}`,
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
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method:
                "eth_chainId",
              params: [],
            }),
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
      // Fork is not ready yet.
    }

    await sleep(250);
  }

  const detail =
    stderr();

  throw new Error(
    `Timed out after 20s waiting for Anvil fork${
      detail
        ? `: ${detail}`
        : ""
    }`,
  );
}

async function startEthereumFork(): Promise<ForkHandle> {
  /*
   * Do not print the Ethereum RPC URL because it may contain provider
   * credentials.
   *
   * Anvil receives --fork-url directly. URL-authenticated providers work
   * normally. Tatum's separate x-api-key header is intentionally rejected
   * because this child process does not forward that header.
   */
  if (
    config.ethereumRpcApiKey &&
    /(?:^|\/\/)[^/]*tatum\.io(?:\/|$)/i.test(
      config.ethereumRpcUrl,
    )
  ) {
    throw new Error(
      "Phase 4 Ethereum Anvil fork cannot use the Tatum x-api-key header configuration. Use an Ethereum RPC whose authentication is embedded in ETHEREUM_RPC_URL.",
    );
  }

  const child =
    spawn(
      "anvil",
      [
        "--port",
        String(ETH_PORT),
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

  const url =
    `http://127.0.0.1:${ETH_PORT}`;

  const provider =
    new JsonRpcProvider(
      url,
      {
        chainId:
          ADDRESSES.ethereum
            .chainId,
        name:
          "Ethereum Fork",
      },
      {
        staticNetwork: true,
        batchMaxCount: 1,
      },
    );

  const handle: ForkHandle = {
    process: child,
    provider,
    url,
    stderr: () =>
      stderrBuffer.trim(),
  };

  try {
    await waitForFork(
      child,
      url,
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

async function firstUnlockedAccount(
  provider: JsonRpcProvider,
): Promise<string> {
  const accounts =
    await provider.send(
      "eth_accounts",
      [],
    );

  if (
    !Array.isArray(
      accounts,
    ) ||
    accounts.length === 0 ||
    typeof accounts[0] !==
      "string"
  ) {
    throw new Error(
      "Anvil did not expose an unlocked local account",
    );
  }

  return accounts[0];
}

async function forkDeadline(
  provider: JsonRpcProvider,
): Promise<bigint> {
  const block =
    await provider.getBlock(
      "latest",
    );

  if (!block) {
    throw new Error(
      "Unable to read Ethereum fork block",
    );
  }

  return (
    BigInt(
      block.timestamp,
    ) + 3_600n
  );
}

async function simulateEthereumBuy(
  candidate: OpportunityCandidate,
): Promise<SimulatedLeg> {
  console.log(
    "[ETH] Starting local Anvil fork...",
  );

  const fork =
    await startEthereumFork();

  try {
    console.log(
      "[ETH] Fork ready.",
    );

    const trader =
      await firstUnlockedAccount(
        fork.provider,
      );

    const signer =
      await fork.provider.getSigner(
        trader,
      );

    const weth =
      new Contract(
        ADDRESSES.ethereum.weth,
        WETH_ABI,
        signer,
      );

    const wabit =
      new Contract(
        ADDRESSES.ethereum.wabit,
        ERC20_ABI,
        signer,
      );

    const router =
      new Contract(
        ADDRESSES.ethereum
          .uniswapV2Router02,
        UNISWAP_V2_ROUTER02_ABI,
        signer,
      );

    /*
     * Setup only. These operations are excluded from recurring arb gas.
     */
    console.log(
      "[ETH] Preparing fork-only WETH...",
    );

    const wrapTx =
      await weth.deposit({
        value:
          candidate
            .requestedWethRaw,
      });

    await wrapTx.wait();

    const approveTx =
      await weth.approve(
        ADDRESSES.ethereum
          .uniswapV2Router02,
        MaxUint256,
      );

    await approveTx.wait();

    const beforeWabit =
      BigInt(
        await wabit.balanceOf(
          trader,
        ),
      );

    const deadline =
      await forkDeadline(
        fork.provider,
      );

    const args = [
      candidate.requestedWethRaw,
      0n,
      [
        ADDRESSES.ethereum.weth,
        ADDRESSES.ethereum.wabit,
      ],
      trader,
      deadline,
    ] as const;

    /*
     * amountOutMin = 0 is permitted only because this is an isolated fork.
     * Live execution must derive a protected minimum from a fresh quote.
     */
    console.log(
      "[ETH] Estimating swap gas...",
    );

    const estimatedGas =
      BigInt(
        await router
          .swapExactTokensForTokensSupportingFeeOnTransferTokens
          .estimateGas(
            ...args,
          ),
      );

    console.log(
      "[ETH] Executing swap on local fork...",
    );

    const tx =
      await router
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          ...args,
        );

    const receipt =
      await tx.wait();

    if (!receipt) {
      throw new Error(
        "Ethereum fork transaction produced no receipt",
      );
    }

    const afterWabit =
      BigInt(
        await wabit.balanceOf(
          trader,
        ),
      );

    const actualOutputRaw =
      afterWabit -
      beforeWabit;

    console.log(
      "[ETH] Fork swap mined.",
    );

    return {
      chain: "Ethereum",
      engine: "Anvil",
      action:
        "WETH -> WABIT via Uniswap V2 Router02 supporting fee-on-transfer tokens",
      estimatedGas,
      gasUsed:
        receipt.gasUsed,
      expectedOutputRaw:
        candidate.acquiredWabitRaw,
      actualOutputRaw,
      outputDifferenceBps:
        differenceBps(
          actualOutputRaw,
          candidate
            .acquiredWabitRaw,
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
    "rhc-sim",
  );
}

function parseForgeUint(
  output: string,
  key: string,
): bigint {
  const pattern =
    new RegExp(
      `${key}:\\s*(\\d+)`,
    );

  const match =
    output.match(pattern);

  if (!match?.[1]) {
    throw new Error(
      `Forge RHC simulation did not emit ${key}`,
    );
  }

  return BigInt(
    match[1],
  );
}

async function runForgeRhcSimulation(
  wabitInputRaw: bigint,
): Promise<ForgeRhcResult> {
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
      "RHC Forge simulation project is missing at forge/rhc-sim",
    );
  }

  console.log(
    "[RHC] Starting Forge mainnet fork simulation...",
  );

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
              "RhcSellForkSimulation",
              "--match-test",
              "testSimulateRhcSell",
              "-vv",
              "--color",
              "never",
            ],
            {
              cwd,
              env: {
                ...process.env,
                DAWAB_RHC_WABIT_IN:
                  wabitInputRaw.toString(),
              },
              stdio: [
                "ignore",
                "pipe",
                "pipe",
              ],
              windowsHide: true,
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
                  "Forge RHC simulation timed out after 90s",
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
            clearTimeout(timer);

            rejectPromise(
              new Error(
                `Unable to launch Forge for RHC simulation: ${error.message}`,
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
            clearTimeout(timer);

            const combined =
              `${stdout}\n${stderr}`;

            if (code !== 0) {
              /*
               * Forge output does not contain private keys. The RHC RPC is
               * public, but we still avoid echoing the command itself.
               */
              const tail =
                combined
                  .trim()
                  .split(/\r?\n/)
                  .slice(-30)
                  .join("\n");

              rejectPromise(
                new Error(
                  `Forge RHC simulation failed${
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

  const routerCallGasUsed =
    parseForgeUint(
      output,
      "DAWAB_RHC_ROUTER_CALL_GAS",
    );

  const quotedWethOutRaw =
    parseForgeUint(
      output,
      "DAWAB_RHC_QUOTED_WETH_OUT",
    );

  const actualWethOutRaw =
    parseForgeUint(
      output,
      "DAWAB_RHC_ACTUAL_WETH_OUT",
    );

  console.log(
    "[RHC] Forge fork execution passed.",
  );

  return {
    routerCallGasUsed,
    quotedWethOutRaw,
    actualWethOutRaw,
  };
}

async function simulateRhcSell(
  candidate: OpportunityCandidate,
  actualWabitInputRaw: bigint,
): Promise<SimulatedLeg> {
  console.log(
    `[RHC] Simulating exact Ethereum output: ${actualWabitInputRaw.toString()} raw WABIT`,
  );

  const forgeResult =
    await runForgeRhcSimulation(
      actualWabitInputRaw,
    );

  if (
    forgeResult
      .actualWethOutRaw !==
    forgeResult
      .quotedWethOutRaw
  ) {
    throw new Error(
      `RHC Forge execution output does not match its own quote: quote=${forgeResult.quotedWethOutRaw.toString()} actual=${forgeResult.actualWethOutRaw.toString()}`,
    );
  }

  /*
   * Forge gives us direct execution gas for the deployed router path.
   * Add worst-case intrinsic calldata gas so the P&L model does not treat
   * router-call gas as if it were a complete externally owned account tx.
   *
   * This intentionally errs slightly high because:
   * - the real calldata contains zero bytes,
   * - the Forge external-call measurement itself contains a small CALL
   *   overhead that a direct EOA transaction would not.
   */
  const modeledTransactionGas =
    forgeResult
      .routerCallGasUsed +
    RHC_MAX_INTRINSIC_GAS;

  return {
    chain: "RHC",
    engine: "Forge",
    action:
      "WABIT -> WETH via deployed ReLaunchTradeRouter on forked RHC state",
    estimatedGas:
      forgeResult
        .routerCallGasUsed,
    gasUsed:
      modeledTransactionGas,
    expectedOutputRaw:
      candidate.outputWethRaw,
    actualOutputRaw:
      forgeResult
        .actualWethOutRaw,
    outputDifferenceBps:
      differenceBps(
        forgeResult
          .actualWethOutRaw,
        candidate
          .outputWethRaw,
      ),
  };
}

export async function simulateBestOpportunity(
  sweep: OpportunitySweep,
): Promise<Phase4Simulation> {
  const candidate =
    sweep.bestGross;

  if (
    candidate == null ||
    candidate
      .grossProfitWethRaw ==
      null ||
    candidate
      .grossProfitWethRaw <=
      0n
  ) {
    throw new Error(
      "No positive Phase 3 opportunity is available to simulate",
    );
  }

  if (
    candidate.direction !==
    "BUY_ETH_SELL_RHC"
  ) {
    throw new Error(
      `Phase 4 currently simulates BUY_ETH_SELL_RHC only; best direction is ${candidate.direction}`,
    );
  }

  const ethereum =
    await simulateEthereumBuy(
      candidate,
    );

  /*
   * Phase 3 and the Ethereum fork should remain tightly aligned.
   * If they do not, stop before attempting the opposite leg.
   */
  if (
    ethereum
      .outputDifferenceBps >
    1
  ) {
    throw new Error(
      `Ethereum fork execution differs from Phase 3 model by ${ethereum.outputDifferenceBps.toFixed(
        4,
      )} bps`,
    );
  }

  /*
   * Critical Phase 4 behavior:
   * feed the exact WABIT actually received on the Ethereum fork into the
   * RHC Forge simulation. Do not recycle Phase 3's modeled token amount.
   */
  const rhc =
    await simulateRhcSell(
      candidate,
      ethereum.actualOutputRaw,
    );

  if (
    rhc.outputDifferenceBps >
    1
  ) {
    throw new Error(
      `RHC fork execution differs from Phase 3 quote by ${rhc.outputDifferenceBps.toFixed(
        4,
      )} bps`,
    );
  }

  const ethereumGasCostWethRaw =
    ethereum.gasUsed *
    sweep.gas
      .ethereumGasPriceWei;

  const rhcGasCostWethRaw =
    rhc.gasUsed *
    sweep.gas
      .rhcGasPriceWei;

  const totalGasCostWethRaw =
    ethereumGasCostWethRaw +
    rhcGasCostWethRaw;

  /*
   * Gross profit is now based on the two executed fork legs rather than
   * Phase 3's modeled gross.
   */
  const grossProfitWethRaw =
    rhc.actualOutputRaw -
    candidate
      .requestedWethRaw;

  const netProfitWethRaw =
    grossProfitWethRaw -
    totalGasCostWethRaw;

  return {
    candidate,
    ethereum,
    rhc,

    ethereumGasCostWethRaw,
    rhcGasCostWethRaw,
    totalGasCostWethRaw,

    grossProfitWethRaw,
    netProfitWethRaw,
    netProfitBps:
      signedBps(
        netProfitWethRaw,
        candidate
          .requestedWethRaw,
      ),

    executionStatus:
      "FORK_SIMULATED",
  };
}

export function renderPhase4Simulation(
  result: Phase4Simulation,
): string {
  const {
    candidate,
    ethereum,
    rhc,
  } = result;

  const formatWeth = (
    raw: bigint,
    digits = 8,
  ): string =>
    Number(
      formatEther(raw),
    ).toFixed(digits);

  const signedWeth = (
    raw: bigint,
  ): string =>
    `${raw >= 0n ? "+" : ""}${formatWeth(
      raw,
      8,
    )}`;

  return [
    "",
    "Phase 4 hybrid-fork execution simulation",
    "────────────────────────────────────────",
    "Public-chain broadcast: NONE",
    "Ethereum engine:        Anvil fork",
    "RHC engine:             Forge fork",
    `Direction:              ETH -> RHC`,
    `Optimized input:        ${formatWeth(
      candidate
        .requestedWethRaw,
      10,
    )} WETH`,
    "",
    "Ethereum leg",
    `Route:                  ${ethereum.action}`,
    `Gas estimate:           ${ethereum.estimatedGas.toString()}`,
    `Receipt gas used:       ${ethereum.gasUsed.toString()}`,
    `WABIT actually received:${ethereum.actualOutputRaw.toString()}`,
    `Output model delta:     ${ethereum.outputDifferenceBps.toFixed(
      4,
    )} bps`,
    "",
    "RHC leg",
    `Route:                  ${rhc.action}`,
    `Forge router-call gas:  ${rhc.estimatedGas.toString()}`,
    `Modeled tx gas:         ${rhc.gasUsed.toString()}`,
    `Actual WETH out:        ${formatWeth(
      rhc.actualOutputRaw,
      10,
    )} WETH`,
    `Output quote delta:     ${rhc.outputDifferenceBps.toFixed(
      4,
    )} bps`,
    "",
    "Gas-adjusted economics",
    `Executed gross profit:  ${signedWeth(
      result
        .grossProfitWethRaw,
    )} WETH`,
    `Ethereum gas cost:      -${formatWeth(
      result
        .ethereumGasCostWethRaw,
      8,
    )} WETH`,
    `RHC gas cost:           -${formatWeth(
      result
        .rhcGasCostWethRaw,
      8,
    )} WETH`,
    `Total gas cost:         -${formatWeth(
      result
        .totalGasCostWethRaw,
      8,
    )} WETH`,
    `Modeled net profit:     ${signedWeth(
      result
        .netProfitWethRaw,
    )} WETH`,
    `Modeled net return:     ${result.netProfitBps >= 0 ? "+" : ""}${(
      result.netProfitBps /
      100
    ).toFixed(4)}%`,
    "",
    `Execution status:       ${result.executionStatus}`,
    "",
    "Setup-only WETH wrapping, fork inventory seeding, and ERC-20 approvals are excluded from recurring trade gas.",
    "RHC modeled tx gas = Forge-measured router-call gas + conservative maximum intrinsic calldata gas.",
    "Live execution remains disabled. No --broadcast flag is used anywhere in Phase 4.",
    "",
  ].join("\n");
}
