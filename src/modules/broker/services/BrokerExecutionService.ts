// // src/modules/broker/services/BrokerExecutionService.ts

// import { BrokerFactory } from "../core/BrokerFactory";
// import { BrokerError } from "../core/errors";
// import {
//   CancelOrderRequest,
//   CancelOrderResponse,
//   Holding,
//   IndiaBroker,
//   ModifyOrderRequest,
//   ModifyOrderResponse,
//   Order,
//   PlaceOrderRequest,
//   PlaceOrderResponse,
//   Position,
// } from "../core/types";
// import { BrokerSessionService } from "./BrokerSessionService";

// export type ExecutionContext = {
//   userId: number;
//   broker: IndiaBroker;

//   // ✅ passed from gateway/main backend
//   brokerCreds: any;

//   requestId?: string;
//   ip?: string;
//   userAgent?: string;
// };

// export class BrokerExecutionService {
//   constructor(private sessions: BrokerSessionService) {}

//   private getAdapter(broker: IndiaBroker, brokerCreds: any) {
//     return BrokerFactory.create(broker, brokerCreds);
//   }

//   async placeOrder(ctx: ExecutionContext, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
//     if (!ctx?.userId) throw new BrokerError("userId is required", { statusCode: 400 });
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.placeOrder(liveSession, order);
//   }

//   async modifyOrder(ctx: ExecutionContext, payload: ModifyOrderRequest): Promise<ModifyOrderResponse> {
//     if (!payload?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.modifyOrder(liveSession, payload);
//   }

//   async cancelOrder(ctx: ExecutionContext, payload: CancelOrderRequest): Promise<CancelOrderResponse> {
//     if (!payload?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.cancelOrder(liveSession, payload);
//   }

//   async getOrders(ctx: ExecutionContext): Promise<Order[]> {
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.getOrders(liveSession);
//   }

//   async getPositions(ctx: ExecutionContext): Promise<Position[]> {
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.getPositions(liveSession);
//   }

//   async getHoldings(ctx: ExecutionContext): Promise<Holding[]> {
//     if (!ctx?.brokerCreds) throw new BrokerError("brokerCreds missing", { statusCode: 400, code: "BROKER_CREDS_MISSING" });

//     const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
//     const liveSession = await this.sessions.maybeRefresh(session);

//     const adapter = this.getAdapter(ctx.broker, ctx.brokerCreds);
//     return adapter.getHoldings(liveSession);
//   }
// }
// src/modules/broker/services/BrokerExecutionService.ts

import { BrokerFactory } from "../core/BrokerFactory";
import { BrokerError } from "../core/errors";
import {
  CancelOrderRequest,
  CancelOrderResponse,
  Holding,
  IndiaBroker,
  ModifyOrderRequest,
  ModifyOrderResponse,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Position,
} from "../core/types";
import { BrokerSessionService } from "./BrokerSessionService";

export type ExecutionContext = {
  userId: number;
  broker: IndiaBroker;

  requestId?: string;
  ip?: string;
  userAgent?: string;
};

export class BrokerExecutionService {
  constructor(private sessions: BrokerSessionService) {}

  private createAdapter(broker: IndiaBroker, creds: any) {
    if (!creds || typeof creds !== "object") {
      throw new BrokerError("Missing broker creds in body", {
        statusCode: 400,
        code: "BROKER_CREDS_MISSING",
      });
    }
    return BrokerFactory.create(broker, creds);
  }

  async placeOrder(
    ctx: ExecutionContext,
    creds: any,
    order: PlaceOrderRequest,
  ): Promise<PlaceOrderResponse> {
    if (!ctx?.userId) throw new BrokerError("userId is required", { statusCode: 400 });

    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.placeOrder(liveSession, order);
  }

  async modifyOrder(
    ctx: ExecutionContext,
    creds: any,
    payload: ModifyOrderRequest,
  ): Promise<ModifyOrderResponse> {
    if (!payload?.orderId) {
      throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.modifyOrder(liveSession, payload);
  }

  async cancelOrder(
    ctx: ExecutionContext,
    creds: any,
    payload: CancelOrderRequest,
  ): Promise<CancelOrderResponse> {
    if (!payload?.orderId) {
      throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.cancelOrder(liveSession, payload);
  }

  async getOrders(ctx: ExecutionContext, creds: any): Promise<Order[]> {
    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.getOrders(liveSession);
  }

  async getPositions(ctx: ExecutionContext, creds: any): Promise<Position[]> {
    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.getPositions(liveSession);
  }

  async getHoldings(ctx: ExecutionContext, creds: any): Promise<Holding[]> {
    const session = await this.sessions.requireSession(ctx.userId, ctx.broker);
    const liveSession = await this.sessions.maybeRefresh(session);

    const adapter = this.createAdapter(ctx.broker, creds);
    return adapter.getHoldings(liveSession);
  }
}
