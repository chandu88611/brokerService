// // src/modules/broker/controllers/brokerAuth.controller.ts

// import { Request, Response } from "express";
// import { BrokerFactory } from "../core/BrokerFactory";
// import { BrokerError } from "../core/errors";
// import { ExchangeTokenParams, IndiaBroker, LoginUrlParams } from "../core/types";
// import { BrokerSessionService } from "../services/BrokerSessionService";
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
//     throw new BrokerError(`Invalid broker: ${x}`, { statusCode: 400, code: "BROKER_INVALID" });
//   }
//   return v as IndiaBroker;
// }

// function requireUserId(req: Request): number {
//   const userId = Number((req as any)?.user?.id || req.headers["x-user-id"]);
//   if (!Number.isFinite(userId) || userId <= 0) {
//     throw new BrokerError("Unauthorized (missing userId)", { statusCode: 401, code: "UNAUTHORIZED" });
//   }
//   return userId;
// }

// function readCallbackParams(req: Request): Record<string, string | undefined> {
//   const out: Record<string, string | undefined> = {};
//   for (const [k, v] of Object.entries(req.query || {})) if (typeof v === "string") out[k] = v;
//   if (req.body && typeof req.body === "object") {
//     for (const [k, v] of Object.entries(req.body)) if (typeof v === "string") out[k] = v;
//   }
//   return out;
// }

// export function createBrokerAuthController(deps: { sessions: BrokerSessionService }) {
//   const { sessions } = deps;

//   return {
//     async getLoginUrl(req: Request, res: Response) {
//       const userId = requireUserId(req);
//       const broker = asIndiaBroker(req.params.broker);

//       // ✅ creds come ONLY from request
//       const brokerCreds = readCredsFromRequest(req);
//       const adapter = BrokerFactory.create(broker, brokerCreds);

//       const params: LoginUrlParams = {
//         userId,
//         broker,
//         state: typeof req.query.state === "string" ? req.query.state : undefined,
//         redirectUri: typeof req.query.redirectUri === "string" ? req.query.redirectUri : undefined,
//       };

//       const url = await adapter.getLoginUrl(params);
//       res.json({ broker, authType: adapter.authType, loginUrl: url });
//     },

//     async callback(req: Request, res: Response) {
//       const userId = requireUserId(req);
//       const broker = asIndiaBroker(req.params.broker);

//       const brokerCreds = readCredsFromRequest(req);
//       const adapter = BrokerFactory.create(broker, brokerCreds);

//       const callbackParams = readCallbackParams(req);

//       const params: ExchangeTokenParams = {
//         userId,
//         broker,
//         callbackParams,

//         // optional convenience aliases
//         code: callbackParams.code,
//         authCode: callbackParams.authCode || callbackParams.auth_code,
//         requestToken: callbackParams.request_token || callbackParams.requestToken,
//         state: callbackParams.state,
//       };

//       const session = await adapter.exchangeToken(params);

//       session.userId = userId;
//       session.broker = broker;

//       await sessions.saveSession(session);

//       res.json({
//         ok: true,
//         broker,
//         saved: true,
//         expiresAt: session.expiresAt ?? null,
//         meta: session.meta ?? {},
//       });
//     },

//     async disconnect(req: Request, res: Response) {
//       const userId = requireUserId(req);
//       const broker = asIndiaBroker(req.params.broker);

//       await sessions.disconnect(userId, broker);
//       res.json({ ok: true, broker, disconnected: true });
//     },
//   };
// }
// src/modules/broker/controllers/brokerAuth.controller.ts

import { Request, Response } from "express";
import { BrokerFactory } from "../core/BrokerFactory";
import { BrokerError } from "../core/errors";
import { ExchangeTokenParams, IndiaBroker, LoginUrlParams } from "../core/types";
import { BrokerSessionService } from "../services/BrokerSessionService";

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
    throw new BrokerError(`Invalid broker: ${x}`, {
      statusCode: 400,
      code: "BROKER_INVALID",
    });
  }
  return v as IndiaBroker;
}

function requireUserId(req: Request): number {
  const userId = Number((req as any)?.user?.id || req.headers["x-user-id"]);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new BrokerError("Unauthorized (missing userId)", {
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  }
  return userId;
}

// brokers vary: take callback params from query and body.callbackParams
function readCallbackParams(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};

  // query params
  for (const [k, v] of Object.entries(req.query || {})) {
    if (typeof v === "string") out[k] = v;
  }

  // body.callbackParams (preferred)
  const cp = (req.body && typeof req.body === "object" ? (req.body as any).callbackParams : null) || null;
  if (cp && typeof cp === "object") {
    for (const [k, v] of Object.entries(cp)) {
      if (typeof v === "string") out[k] = v;
    }
  }

  // fallback: body direct strings
  if (req.body && typeof req.body === "object") {
    for (const [k, v] of Object.entries(req.body)) {
      if (typeof v === "string") out[k] = v;
    }
  }

  return out;
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

export function createBrokerAuthController(deps: { sessions: BrokerSessionService }) {
  const { sessions } = deps;

  return {
    /**
     * POST /broker/:broker/login-url
     * Body: { creds, redirectUri?, state? }
     */
    async getLoginUrl(req: Request, res: Response) {
      const userId = requireUserId(req);
      const broker = asIndiaBroker(req.params.broker);
      const creds = requireCreds(req);

      const adapter = BrokerFactory.create(broker, creds);

      const params: LoginUrlParams = {
        userId,
        broker,
        state: typeof (req.body as any)?.state === "string" ? (req.body as any).state : undefined,
        redirectUri:
          typeof (req.body as any)?.redirectUri === "string" ? (req.body as any).redirectUri : undefined,
      };

      const url = await adapter.getLoginUrl(params);

      res.json({ broker, authType: adapter.authType, loginUrl: url });
    },

    /**
     * POST /broker/:broker/callback
     * Body: { creds, callbackParams?: {...} }  OR query params can contain callback too
     */
    async callback(req: Request, res: Response) {
      const userId = requireUserId(req);
      const broker = asIndiaBroker(req.params.broker);
      const creds = requireCreds(req);

      const adapter = BrokerFactory.create(broker, creds);
      const callbackParams = readCallbackParams(req);

      const params: ExchangeTokenParams = { userId, broker, callbackParams };
      const session = await adapter.exchangeToken(params);

      session.userId = userId;
      session.broker = broker;

      await sessions.saveSession(session);

      res.json({
        ok: true,
        broker,
        saved: true,
        expiresAt: session.expiresAt ?? null,
        meta: session.meta ?? {},
      });
    },

    /**
     * POST /broker/:broker/disconnect
     */
    async disconnect(req: Request, res: Response) {
      const userId = requireUserId(req);
      const broker = asIndiaBroker(req.params.broker);

      await sessions.disconnect(userId, broker);
      res.json({ ok: true, broker, disconnected: true });
    },
  };
}
