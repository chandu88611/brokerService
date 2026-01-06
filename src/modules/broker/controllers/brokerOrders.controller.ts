// // src/modules/broker/controllers/brokerOrders.controller.ts

// import { Request, Response } from "express";
// import { BrokerError } from "../core/errors";
// import { IndiaBroker, PlaceOrderRequest } from "../core/types";
// import { BrokerExecutionService } from "../services/BrokerExecutionService";
// import { readCredsFromRequest } from "../core/credsFromRequest";

// function asIndiaBroker(x: string): IndiaBroker {
//   const v = (x || "").toUpperCase().trim();
//   const allowed: IndiaBroker[] = [
//     "ZERODHA",
//     "UPSTOX",
//     "FYERS",
//     "ANGELONE",
//     "DHAN",
//     "ZEBU",
//     "ALICEBLUE",
//     "DELTA_EXCHANGE",
//   ];
//   if (!allowed.includes(v as IndiaBroker)) {
//     throw new BrokerError(`Invalid broker: ${x}`, { statusCode: 400 });
//   }
//   return v as IndiaBroker;
// }

// function requireUserId(req: Request): number {
//   const uid = Number((req as any)?.user?.id || req.headers["x-user-id"]);
//   if (!Number.isFinite(uid) || uid <= 0) {
//     throw new BrokerError("Unauthorized (missing userId)", { statusCode: 401 });
//   }
//   return uid;
// }

// export function createBrokerOrdersController(deps: { execution: BrokerExecutionService }) {
//   const { execution } = deps;

//   return {
//     async placeOrder(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const payload = req.body as PlaceOrderRequest;
//       if (!payload?.symbol || !payload?.side || !payload?.quantity) {
//         throw new BrokerError("Invalid order payload", {
//           statusCode: 400,
//           code: "ORDER_INVALID",
//           details: payload,
//         });
//       }

//       const result = await execution.placeOrder(
//         { userId, broker, brokerCreds, requestId: (req as any).requestId, ip: req.ip, userAgent: req.headers["user-agent"] },
//         payload,
//       );

//       res.json(result);
//     },

//     async modifyOrder(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const result = await execution.modifyOrder(
//         { userId, broker, brokerCreds, requestId: (req as any).requestId, ip: req.ip, userAgent: req.headers["user-agent"] },
//         req.body,
//       );

//       res.json(result);
//     },

//     async cancelOrder(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const result = await execution.cancelOrder(
//         { userId, broker, brokerCreds, requestId: (req as any).requestId, ip: req.ip, userAgent: req.headers["user-agent"] },
//         req.body,
//       );

//       res.json(result);
//     },

//     async getOrders(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const orders = await execution.getOrders({
//         userId,
//         broker,
//         brokerCreds,
//         requestId: (req as any).requestId,
//         ip: req.ip,
//         userAgent: req.headers["user-agent"],
//       });

//       res.json({ broker, orders });
//     },

//     async getPositions(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const positions = await execution.getPositions({
//         userId,
//         broker,
//         brokerCreds,
//         requestId: (req as any).requestId,
//         ip: req.ip,
//         userAgent: req.headers["user-agent"],
//       });

//       res.json({ broker, positions });
//     },

//     async getHoldings(req: Request, res: Response) {
//       const broker = asIndiaBroker(req.params.broker);
//       const userId = requireUserId(req);

//       const brokerCreds = readCredsFromRequest(req);

//       const holdings = await execution.getHoldings({
//         userId,
//         broker,
//         brokerCreds,
//         requestId: (req as any).requestId,
//         ip: req.ip,
//         userAgent: req.headers["user-agent"],
//       });

//       res.json({ broker, holdings });
//     },
//   };
// }
// src/modules/broker/controllers/brokerOrders.controller.ts

import { Request, Response } from "express";
import { BrokerError } from "../core/errors";
import { IndiaBroker, PlaceOrderRequest } from "../core/types";
import { BrokerExecutionService } from "../services/BrokerExecutionService";

function asIndiaBroker(x: string): IndiaBroker {
  const v = (x || "").toUpperCase().trim();
  const allowed: IndiaBroker[] = [
    "ZERODHA",
    "UPSTOX",
    "FYERS",
    "ANGELONE",
    "DHAN",
    "ZEBU",
    "ALICEBLUE",
  ];
  if (!allowed.includes(v as IndiaBroker)) {
    throw new BrokerError(`Invalid broker: ${x}`, { statusCode: 400, code: "BROKER_INVALID" });
  }
  return v as IndiaBroker;
}

function requireUserId(req: Request): number {
  const uid = Number((req as any)?.user?.id || req.headers["x-user-id"]);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new BrokerError("Unauthorized (missing userId)", { statusCode: 401, code: "UNAUTHORIZED" });
  }
  return uid;
}

function requireCreds(req: Request): any {
  const creds = (req.body && typeof req.body === "object" ? (req.body as any).creds : null) || null;
  if (!creds || typeof creds !== "object") {
    throw new BrokerError("Missing broker creds in body", {
      statusCode: 400,
      code: "BROKER_CREDS_MISSING",
    });
  }
  return creds;
}

export function createBrokerOrdersController(deps: { execution: BrokerExecutionService }) {
  const { execution } = deps;

  return {
    /**
     * POST /broker/:broker/orders/place
     * Body: { creds, order }
     */
    async placeOrder(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const order = (req.body as any)?.order as PlaceOrderRequest;
      if (!order?.symbol || !order?.side || !order?.quantity) {
        throw new BrokerError("Invalid order payload (expected body.order)", {
          statusCode: 400,
          code: "ORDER_INVALID",
          details: req.body,
        });
      }

      const result = await execution.placeOrder(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
        order,
      );

      res.json(result);
    },

    /**
     * POST /broker/:broker/orders/modify
     * Body: { creds, orderId, ...fields }
     */
    async modifyOrder(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const result = await execution.modifyOrder(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
        req.body,
      );

      res.json(result);
    },

    /**
     * POST /broker/:broker/orders/cancel
     * Body: { creds, orderId }
     */
    async cancelOrder(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const result = await execution.cancelOrder(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
        req.body,
      );

      res.json(result);
    },

    /**
     * POST /broker/:broker/orders
     * Body: { creds }
     */
    async getOrders(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const orders = await execution.getOrders(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
      );

      res.json({ broker, orders });
    },

    /**
     * POST /broker/:broker/positions
     * Body: { creds }
     */
    async getPositions(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const positions = await execution.getPositions(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
      );

      res.json({ broker, positions });
    },

    /**
     * POST /broker/:broker/holdings
     * Body: { creds }
     */
    async getHoldings(req: Request, res: Response) {
      const broker = asIndiaBroker(req.params.broker);
      const userId = requireUserId(req);
      const creds = requireCreds(req);

      const holdings = await execution.getHoldings(
        {
          userId,
          broker,
          requestId: (req as any).requestId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
        creds,
      );

      res.json({ broker, holdings });
    },
  };
}
