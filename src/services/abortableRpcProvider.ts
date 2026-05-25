import { AsyncLocalStorage } from "node:async_hooks";
import { FetchRequest, JsonRpcProvider } from "ethers";
import type { JsonRpcApiProviderOptions, JsonRpcPayload, JsonRpcResult, Networkish } from "ethers";

export class AbortableJsonRpcProvider extends JsonRpcProvider {
  private readonly activeRequests = new Set<FetchRequest>();
  private readonly requestScopes = new AsyncLocalStorage<Set<FetchRequest>>();

  cancelInflight(): number {
    return cancelRequests(this.activeRequests);
  }

  runWithRequestScope<T>(work: () => Promise<T>): { promise: Promise<T>; cancel: () => number } {
    const scope = new Set<FetchRequest>();
    const promise = this.requestScopes.run(scope, () => Promise.resolve().then(work));
    return {
      promise,
      cancel: () => cancelRequests(scope)
    };
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader("content-type", "application/json");

    const scope = this.requestScopes.getStore();
    const responsePromise = request.send();
    this.activeRequests.add(request);
    scope?.add(request);
    try {
      const response = await responsePromise;
      response.assertOk();
      const body = response.bodyJson as JsonRpcResult | JsonRpcResult[];
      return Array.isArray(body) ? body : [body];
    } finally {
      this.activeRequests.delete(request);
      scope?.delete(request);
    }
  }
}

function cancelRequests(requests: Set<FetchRequest>): number {
  let cancelled = 0;
  for (const request of [...requests]) {
    try {
      request.cancel();
      cancelled++;
    } catch {
      // The request may already have settled between snapshotting and cancelling.
    }
  }
  return cancelled;
}

export function createAbortableJsonRpcProvider(
  url: string,
  network?: Networkish,
  options?: JsonRpcApiProviderOptions
): AbortableJsonRpcProvider {
  return new AbortableJsonRpcProvider(url, network, options);
}

export function cancelProviderInflight(provider: JsonRpcProvider): number {
  const maybeCancellable = provider as JsonRpcProvider & { cancelInflight?: () => number };
  return maybeCancellable.cancelInflight?.() ?? 0;
}

export function runProviderRequestScope<T>(
  provider: JsonRpcProvider,
  work: () => Promise<T>
): { promise: Promise<T>; cancel: () => number } {
  const maybeScoped = provider as JsonRpcProvider & {
    runWithRequestScope?: (work: () => Promise<T>) => { promise: Promise<T>; cancel: () => number };
  };
  return maybeScoped.runWithRequestScope?.(work) ?? {
    promise: Promise.resolve().then(work),
    cancel: () => 0
  };
}
