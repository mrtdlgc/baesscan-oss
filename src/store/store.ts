import path from "node:path";
import type { Storage } from "./storage";
import { JsonStateStore, defaultSettings } from "./jsonStore";
import { SqliteStateStore } from "./sqliteStore";

export type StorageBackend = "auto" | "sqlite" | "json";

export interface CreateStorageOptions {
  backend: StorageBackend;
  dataFile: string;
  defaultBackfillBlocks: number;
}

export function createStorage(opts: CreateStorageOptions): Storage {
  const backend = resolveBackend(opts.backend, opts.dataFile);
  if (backend === "json") {
    return new JsonStateStore(opts.dataFile, opts.defaultBackfillBlocks);
  }
  // SQLite path: if DATA_FILE is the legacy state.json, point at state.db in the same dir.
  // The sqlite store still auto-migrates state.json content on first boot.
  const dbPath = opts.dataFile.endsWith(".json")
    ? path.join(path.dirname(opts.dataFile), "state.db")
    : opts.dataFile;
  return new SqliteStateStore(dbPath, opts.defaultBackfillBlocks);
}

function resolveBackend(backend: StorageBackend, dataFile: string): "sqlite" | "json" {
  if (backend === "sqlite") return "sqlite";
  if (backend === "json") return "json";
  // auto: honor explicit .json paths so users who deliberately set DATA_FILE=...state.json
  // get a JSON store back. Default is sqlite for multi-tenant use.
  if (/\.json$/i.test(dataFile)) return "json";
  return "sqlite";
}

export { defaultSettings };
export type { Storage };
// Backwards-compatible re-export for older imports.
export { JsonStateStore as StateStore };
