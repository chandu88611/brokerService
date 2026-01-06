// src/modules/broker/core/BrokerFactory.ts

import { BrokerError } from "./errors";
import { IndiaBroker } from "./types";
import { IBrokerAdapter } from "./IBrokerAdapter";

// import your adapters
import { ZerodhaAdapter } from "../adapters/zerodha.adapter";
import { UpstoxAdapter } from "../adapters/upstox.adapter";
import { FyersAdapter } from "../adapters/fyers.adapter";
import { AngelOneAdapter } from "../adapters/angelone.adapter";
import { DhanAdapter } from "../adapters/dhan.adapter";
import { ZebuAdapter } from "../adapters/zebu.adapter";
import { AliceBlueAdapter } from "../adapters/aliceblue.adapter";
import { DeltaExchangeAdapter } from "../adapters/deltaexchange.adapter";

export class BrokerFactory {
  static create(broker: IndiaBroker, creds: any): IBrokerAdapter {
    switch (broker) {
      case "ZERODHA":
        return new ZerodhaAdapter(creds);
      case "UPSTOX":
        return new UpstoxAdapter(creds);
      case "FYERS":
        return new FyersAdapter(creds);
      case "ANGELONE":
        return new AngelOneAdapter(creds);
      case "DHAN":
        return new DhanAdapter(creds);
      case "ZEBU":
        return new ZebuAdapter(creds);
      case "ALICEBLUE":
        return new AliceBlueAdapter(creds);
      case "DELTA_EXCHANGE":
        return new DeltaExchangeAdapter(creds);
      default:
        throw new BrokerError(`Unsupported broker: ${broker}`, {
          statusCode: 400,
          code: "BROKER_UNSUPPORTED",
        });
    }
  }
}
