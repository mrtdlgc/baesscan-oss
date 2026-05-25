const DEFAULT_RPC_CALL_TIMEOUT_MS = 20_000;

export function rpcCallTimeoutMs(): number {
  const raw = process.env.RPC_CALL_TIMEOUT_MS;
  if (!raw || raw.trim() === "") return DEFAULT_RPC_CALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RPC_CALL_TIMEOUT_MS;
  return Math.max(2_000, Math.min(120_000, Math.floor(parsed)));
}
