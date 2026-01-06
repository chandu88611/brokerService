// src/modules/broker/core/BrokerConfigProvider.ts

import { IndiaBroker } from "./types";

export type BrokerAppCredentials = {
  apiKey: string;
  apiSecret?: string; // secret only needed for token exchange
  redirectUrl?: string; // optional if you want to expose it for UI
};

export interface BrokerConfigProvider {
  /**
   * Returns broker app credentials for this broker.
   * You can implement this by reading from DB or by calling your other service.
   *
   * Note: apiSecret might be unavailable for non-login operations; that's OK.
   */
  getBrokerAppCredentials(params: {
    broker: IndiaBroker;
    userId: number;
  }): Promise<BrokerAppCredentials>;
}
