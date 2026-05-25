import { parentPort, workerData } from "node:worker_threads";
import { SqliteStateStore } from "../store/sqliteStore";
import type {
  WalletPnlAnalyticsSnapshot,
  WalletPnlNewTokensSnapshot,
  WalletPnlProfileSink,
  WalletPnlProfileStage,
  WalletPnlSnapshot
} from "../store/storage";

type WorkerMode = "snapshot" | "analytics" | "newTokens";

interface WorkerData {
  filePath: string;
  defaultBackfillBlocks: number;
  mode: WorkerMode;
  options: Record<string, unknown>;
  profileEnabled: boolean;
}

interface WorkerResult {
  ok: boolean;
  value?: WalletPnlSnapshot | WalletPnlAnalyticsSnapshot | WalletPnlNewTokensSnapshot;
  profile?: WalletPnlProfileStage[];
  error?: string;
}

void run().catch((error) => {
  post({
    ok: false,
    profile: [],
    error: (error as Error).message
  });
});

async function run(): Promise<void> {
  const data = workerData as WorkerData;
  const store = new SqliteStateStore(data.filePath, data.defaultBackfillBlocks);
  await store.load();
  const stages: WalletPnlProfileStage[] = [];
  const profile: WalletPnlProfileSink | undefined = data.profileEnabled ? (stage) => stages.push(stage) : undefined;
  const value = data.mode === "snapshot"
    ? store.buildWalletPnlSnapshotFromFlatTrades({ ...data.options, profile } as Parameters<SqliteStateStore["buildWalletPnlSnapshotFromFlatTrades"]>[0])
    : data.mode === "newTokens"
      ? store.buildWalletPnlNewTokensSnapshotFromFlatTrades({ ...data.options, profile } as Parameters<SqliteStateStore["buildWalletPnlNewTokensSnapshotFromFlatTrades"]>[0])
      : store.buildWalletPnlAnalyticsSnapshotFromFlatTrades({ ...data.options, profile } as Parameters<SqliteStateStore["buildWalletPnlAnalyticsSnapshotFromFlatTrades"]>[0]);
  post({ ok: true, value, profile: stages });
}

function post(message: WorkerResult): void {
  parentPort?.postMessage(message);
}
