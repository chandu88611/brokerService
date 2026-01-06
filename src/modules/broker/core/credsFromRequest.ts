// src/modules/broker/core/credsFromRequest.ts

import { Request } from "express";
import { BrokerError } from "./errors";

/**
 * Expect: x-broker-creds = base64(JSON)
 * Example JSON: { "apiKey":"...", "apiSecret":"...", "redirectUri":"..." }
 */
export function readCredsFromRequest(req: Request): any {
  const h = req.headers["x-broker-creds"];

  if (typeof h !== "string" || !h.trim()) {
    throw new BrokerError("Missing x-broker-creds header (base64(JSON))", {
      statusCode: 400,
      code: "BROKER_CREDS_MISSING",
    });
  }

  try {
    const json = Buffer.from(h, "base64").toString("utf8");
    const creds = JSON.parse(json);
    if (!creds || typeof creds !== "object") throw new Error("invalid creds");
    return creds;
  } catch (e) {
    throw new BrokerError("Invalid x-broker-creds (must be base64(JSON))", {
      statusCode: 400,
      code: "BROKER_CREDS_INVALID",
      details: String(e),
    });
  }
}
