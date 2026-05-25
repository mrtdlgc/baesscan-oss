import type { Address, PoolKey } from "../types";
import { addressToTopic, isSameAddress } from "../utils/address";

export function buildTokenPairFilters(factoryAddress: Address, eventTopic: string, token: Address, quote?: Address) {
  if (quote) {
    const tokenTopic = addressToTopic(token);
    const quoteTopic = addressToTopic(quote);
    return [
      {
        address: factoryAddress,
        topics: [eventTopic, [tokenTopic, quoteTopic], [tokenTopic, quoteTopic]]
      }
    ];
  }

  return [
    {
      address: factoryAddress,
      topics: [eventTopic, addressToTopic(token)]
    },
    {
      address: factoryAddress,
      topics: [eventTopic, null, addressToTopic(token)]
    }
  ];
}

export function poolContainsSelection(pool: PoolKey, token: Address, quote?: Address): boolean {
  if (!isSameAddress(pool.currency0, token) && !isSameAddress(pool.currency1, token)) return false;
  return quote ? isSameAddress(pool.currency0, quote) || isSameAddress(pool.currency1, quote) : true;
}

