import type { AppState, ChatState } from "../types";
import type { TokenInfoRecord } from "./storage";

export function cloneChat(chat: ChatState): ChatState {
  return structuredClone(chat);
}

export function cloneAppState<T extends AppState>(state: T): T {
  return structuredClone(state);
}

export function cloneTokenInfo<T extends TokenInfoRecord | undefined>(record: T): T {
  return (record ? structuredClone(record) : record) as T;
}
