import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";

import {
  dirname,
  resolve,
} from "node:path";

import {
  randomUUID,
} from "node:crypto";

import type {
  OpportunityCandidate,
} from "../types.js";

import type {
  HotExecutionLifecycleEvent,
  HotExecutionResult,
} from "./hotExecutor.js";

const STATE_PATH =
  resolve(
    ".dawab/execution-state.json",
  );

const JOURNAL_PATH =
  resolve(
    ".dawab/execution-journal.jsonl",
  );

export type PersistentExecutionStage =
  | "PREPARING"
  | "RHC_SELL_BROADCAST"
  | "RHC_SELL_MINED"
  | "ETH_HEDGE_BROADCAST"
  | "ETH_HEDGE_MINED";

export interface PersistentExecutionAttempt {
  id:
    string;

  startedAt:
    string;

  updatedAt:
    string;

  stage:
    PersistentExecutionStage;

  direction:
    string;

  requestedWethRaw:
    string;

  expectedGrossProfitWethRaw:
    string | null;

  rhcTxHash:
    string | null;

  ethereumTxHash:
    string | null;
}

export interface PersistentExecutionState {
  version:
    1;

  circuitOpen:
    boolean;

  circuitReason:
    string | null;

  inFlight:
    PersistentExecutionAttempt | null;

  completedTrades:
    number;

  lastCompletedAt:
    string | null;

  lastStatus:
    string | null;

  lastRhcTxHash:
    string | null;

  lastEthereumTxHash:
    string | null;

  lastRealizedNetWethRaw:
    string | null;
}

let cachedState:
  PersistentExecutionState | null =
  null;

function defaultState():
  PersistentExecutionState {
  return {
    version: 1,
    circuitOpen: false,
    circuitReason: null,
    inFlight: null,
    completedTrades: 0,
    lastCompletedAt: null,
    lastStatus: null,
    lastRhcTxHash: null,
    lastEthereumTxHash: null,
    lastRealizedNetWethRaw: null,
  };
}

function stringify(
  value:
    unknown,
): string {
  return JSON.stringify(
    value,
    (
      _key,
      nested,
    ) =>
      typeof nested ===
      "bigint"
        ? nested.toString()
        : nested,
    2,
  );
}

async function ensureDirectory():
  Promise<void> {
  await mkdir(
    dirname(
      STATE_PATH,
    ),
    {
      recursive: true,
    },
  );
}

async function appendJournal(
  event:
    Record<string, unknown>,
): Promise<void> {
  await ensureDirectory();

  await appendFile(
    JOURNAL_PATH,
    `${JSON.stringify({
      timestamp:
        new Date().toISOString(),
      ...event,
    })}\n`,
    "utf8",
  );
}

async function persistState(
  state:
    PersistentExecutionState,
): Promise<void> {
  await ensureDirectory();

  const tempPath =
    `${STATE_PATH}.tmp`;

  await writeFile(
    tempPath,
    `${stringify(state)}\n`,
    "utf8",
  );

  await rename(
    tempPath,
    STATE_PATH,
  );

  cachedState =
    state;
}

async function readStateFile():
  Promise<PersistentExecutionState> {
  try {
    const raw =
      await readFile(
        STATE_PATH,
        "utf8",
      );

    const parsed =
      JSON.parse(
        raw,
      ) as Partial<PersistentExecutionState>;

    if (
      parsed.version !== 1
    ) {
      throw new Error(
        `Unsupported execution-state version: ${String(parsed.version)}`,
      );
    }

    return {
      ...defaultState(),
      ...parsed,
      version: 1,
      completedTrades:
        Number(
          parsed.completedTrades ??
          0,
        ),
    };
  } catch (error: unknown) {
    const code =
      typeof error === "object" &&
      error != null &&
      "code" in error
        ? String(
            (
              error as {
                code?: unknown;
              }
            ).code,
          )
        : null;

    if (
      code === "ENOENT"
    ) {
      return defaultState();
    }

    throw error;
  }
}

export async function initializeExecutionJournal():
  Promise<PersistentExecutionState> {
  const state =
    await readStateFile();

  if (
    state.inFlight != null
  ) {
    const reason =
      `Unresolved live execution attempt ${state.inFlight.id} detected at startup (stage=${state.inFlight.stage}). Manual reconciliation is required before autonomous execution resumes.`;

    state.circuitOpen =
      true;

    state.circuitReason =
      state.circuitReason ??
      reason;

    await persistState(
      state,
    );

    await appendJournal({
      event:
        "STARTUP_UNRESOLVED_ATTEMPT",

      attempt:
        state.inFlight,

      circuitOpen:
        true,

      reason:
        state.circuitReason,
    });

    return state;
  }

  cachedState =
    state;

  return state;
}

export function currentExecutionState():
  PersistentExecutionState {
  return (
    cachedState ??
    defaultState()
  );
}

export async function beginExecutionAttempt(
  candidate:
    OpportunityCandidate,
): Promise<PersistentExecutionAttempt> {
  const state =
    cachedState ??
    await initializeExecutionJournal();

  if (
    state.circuitOpen
  ) {
    throw new Error(
      `Execution circuit breaker is open: ${state.circuitReason ?? "unknown reason"}`,
    );
  }

  if (
    state.inFlight != null
  ) {
    throw new Error(
      `Execution attempt ${state.inFlight.id} is already in flight.`,
    );
  }

  const now =
    new Date().toISOString();

  const attempt:
    PersistentExecutionAttempt = {
    id:
      randomUUID(),

    startedAt:
      now,

    updatedAt:
      now,

    stage:
      "PREPARING",

    direction:
      candidate.direction,

    requestedWethRaw:
      candidate
        .requestedWethRaw
        .toString(),

    expectedGrossProfitWethRaw:
      candidate
        .grossProfitWethRaw
        ?.toString() ??
      null,

    rhcTxHash:
      null,

    ethereumTxHash:
      null,
  };

  const next:
    PersistentExecutionState = {
    ...state,

    inFlight:
      attempt,
  };

  await persistState(
    next,
  );

  await appendJournal({
    event:
      "ATTEMPT_STARTED",

    attempt,
  });

  return attempt;
}

function lifecycleStage(
  event:
    HotExecutionLifecycleEvent,
): PersistentExecutionStage {
  switch (
    event.type
  ) {
    case "RHC_SELL_BROADCAST":
      return "RHC_SELL_BROADCAST";

    case "RHC_SELL_MINED":
      return "RHC_SELL_MINED";

    case "ETH_HEDGE_BROADCAST":
      return "ETH_HEDGE_BROADCAST";

    case "ETH_HEDGE_MINED":
      return "ETH_HEDGE_MINED";
  }
}

export async function recordExecutionLifecycle(
  attemptId:
    string,
  event:
    HotExecutionLifecycleEvent,
): Promise<void> {
  const state =
    cachedState ??
    await initializeExecutionJournal();

  if (
    state.inFlight == null ||
    state.inFlight.id !==
      attemptId
  ) {
    await appendJournal({
      event:
        "LIFECYCLE_WITHOUT_MATCHING_ATTEMPT",

      attemptId,

      lifecycle:
        event,
    });

    return;
  }

  const attempt = {
    ...state.inFlight,

    updatedAt:
      new Date().toISOString(),

    stage:
      lifecycleStage(
        event,
      ),
  };

  if (
    event.type ===
      "RHC_SELL_BROADCAST" ||
    event.type ===
      "RHC_SELL_MINED"
  ) {
    attempt.rhcTxHash =
      event.txHash;
  }

  if (
    event.type ===
      "ETH_HEDGE_BROADCAST" ||
    event.type ===
      "ETH_HEDGE_MINED"
  ) {
    attempt.ethereumTxHash =
      event.txHash;
  }

  await persistState({
    ...state,

    inFlight:
      attempt,
  });

  await appendJournal({
    event:
      event.type,

    attemptId,

    txHash:
      event.txHash,
  });
}

function compactResult(
  result:
    HotExecutionResult,
): Record<string, unknown> {
  return {
    status:
      result.status,

    wallet:
      result.wallet,

    reason:
      result.reason,

    inputWethRaw:
      result
        .inputWethRaw
        .toString(),

    soldWabitRaw:
      result
        .soldWabitRaw
        .toString(),

    rhcWethReceivedRaw:
      result
        .rhcWethReceivedRaw
        .toString(),

    ethereumWabitReceivedRaw:
      result
        .ethereumWabitReceivedRaw
        .toString(),

    realizedGasWei:
      result
        .realizedGasWei
        .toString(),

    realizedNetWethRaw:
      result
        .realizedNetWethRaw
        ?.toString() ??
      null,

    protectedSlippageBps:
      result
        .protection
        ?.maxSymmetricSlippageBps ??
      null,

    rhcTxHash:
      result
        .rhcSell
        ?.txHash ??
      null,

    ethereumTxHash:
      result
        .ethereumBuy
        ?.txHash ??
      null,

    bootstrapTxHashes:
      result
        .bootstrapTransactions
        .map(
          (transaction) =>
            transaction.txHash,
        ),
  };
}

export async function finalizeExecutionAttempt(
  attemptId:
    string,
  result:
    HotExecutionResult,
): Promise<PersistentExecutionState> {
  const state =
    cachedState ??
    await initializeExecutionJournal();

  const matchingAttempt =
    state.inFlight?.id ===
    attemptId
      ? state.inFlight
      : null;

  const circuitOpen =
    result.openedCircuitBreaker ||
    result.status ===
      "CRITICAL_HEDGE_FAILED";

  const completedTrade =
    result.status ===
    "EXECUTED";

  const next:
    PersistentExecutionState = {
    ...state,

    circuitOpen,

    circuitReason:
      circuitOpen
        ? result.reason
        : null,

    inFlight:
      circuitOpen
        ? matchingAttempt
        : null,

    completedTrades:
      state.completedTrades +
      (
        completedTrade
          ? 1
          : 0
      ),

    lastCompletedAt:
      new Date().toISOString(),

    lastStatus:
      result.status,

    lastRhcTxHash:
      result
        .rhcSell
        ?.txHash ??
      matchingAttempt
        ?.rhcTxHash ??
      null,

    lastEthereumTxHash:
      result
        .ethereumBuy
        ?.txHash ??
      matchingAttempt
        ?.ethereumTxHash ??
      null,

    lastRealizedNetWethRaw:
      result
        .realizedNetWethRaw
        ?.toString() ??
      null,
  };

  await persistState(
    next,
  );

  await appendJournal({
    event:
      "ATTEMPT_FINALIZED",

    attemptId,

    circuitOpen,

    result:
      compactResult(
        result,
      ),
  });

  return next;
}

export async function recordExecutionError(
  attemptId:
    string,
  error:
    unknown,
): Promise<PersistentExecutionState> {
  const state =
    cachedState ??
    await initializeExecutionJournal();

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const attempt =
    state.inFlight?.id ===
    attemptId
      ? state.inFlight
      : null;

  const tradeMayHaveBroadcast =
    attempt != null &&
    attempt.stage !==
      "PREPARING";

  const next:
    PersistentExecutionState = {
    ...state,

    circuitOpen:
      tradeMayHaveBroadcast,

    circuitReason:
      tradeMayHaveBroadcast
        ? `Live execution ended unexpectedly after ${attempt.stage}: ${message}`
        : null,

    inFlight:
      tradeMayHaveBroadcast
        ? attempt
        : null,

    lastCompletedAt:
      new Date().toISOString(),

    lastStatus:
      tradeMayHaveBroadcast
        ? "UNRESOLVED_AFTER_BROADCAST"
        : "PRE_BROADCAST_ERROR",

    lastRhcTxHash:
      attempt
        ?.rhcTxHash ??
      state.lastRhcTxHash,

    lastEthereumTxHash:
      attempt
        ?.ethereumTxHash ??
      state.lastEthereumTxHash,
  };

  await persistState(
    next,
  );

  await appendJournal({
    event:
      tradeMayHaveBroadcast
        ? "ATTEMPT_UNRESOLVED_AFTER_BROADCAST"
        : "ATTEMPT_PRE_BROADCAST_ERROR",

    attemptId,

    stage:
      attempt?.stage ??
      null,

    error:
      message,

    circuitOpen:
      next.circuitOpen,
  });

  return next;
}

export async function clearExecutionCircuit(
  reason:
    string,
): Promise<PersistentExecutionState> {
  const state =
    cachedState ??
    await readStateFile();

  const next:
    PersistentExecutionState = {
    ...state,

    circuitOpen:
      false,

    circuitReason:
      null,

    inFlight:
      null,

    lastStatus:
      "OPERATOR_CLEARED_CIRCUIT",
  };

  await persistState(
    next,
  );

  await appendJournal({
    event:
      "OPERATOR_CLEARED_CIRCUIT",

    reason,

    priorCircuitReason:
      state.circuitReason,

    priorInFlight:
      state.inFlight,
  });

  return next;
}

export const executionStatePath =
  STATE_PATH;

export const executionJournalPath =
  JOURNAL_PATH;
