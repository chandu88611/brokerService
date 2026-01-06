// src/modules/broker/adapters/aliceblue.adapter.ts

import axios, { AxiosInstance } from "axios";
import crypto from "crypto";

import { IBrokerAdapter } from "../core/IBrokerAdapter";
import {
  BrokerAuthType,
  BrokerSession,
  CancelOrderRequest,
  CancelOrderResponse,
  ExchangeTokenParams,
  Holding,
  IndiaBroker,
  LoginUrlParams,
  ModifyOrderRequest,
  ModifyOrderResponse,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PlaceOrderSide,
  Position,
} from "../core/types";
import { BrokerAuthError, BrokerError, BrokerUpstreamError } from "../core/errors";

type AliceBlueCreds = {
  appCode: string;   // used in redirect login URL
  apiSecret: string; // used for checksum sha256(userId + authCode + apiSecret)
  baseUrl: string;   // https://ant.aliceblueonline.com
};

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function extractInstrumentId(symbol: string): string {
  const raw = (symbol || "").trim();
  if (!raw) {
    throw new BrokerError("symbol is required (use instrumentId)", {
      statusCode: 400,
      code: "ORDER_INVALID",
    });
  }

  // allow: "instrumentId:22"
  if (raw.startsWith("instrumentId:")) {
    const v = raw.slice("instrumentId:".length).trim();
    if (!/^\d+$/.test(v)) {
      throw new BrokerError("Invalid instrumentId format", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }
    return v;
  }

  // allow direct numeric
  if (/^\d+$/.test(raw)) return raw;

  throw new BrokerError(
    "AliceBlue requires numeric instrumentId. Pass symbol as '22' or 'instrumentId:22'",
    { statusCode: 400, code: "ORDER_INVALID" },
  );
}

function mapProduct(product?: PlaceOrderRequest["product"]) {
  // Alice accepts: INTRADAY / LONGTERM / MTF
  const p = (product || "MIS").toUpperCase();
  if (p === "CNC") return "LONGTERM";
  if (p === "MIS") return "INTRADAY";
  if (p === "NRML") return "MTF";
  return "INTRADAY";
}

function mapOrderType(orderType: PlaceOrderRequest["orderType"]) {
  // Alice accepts: LIMIT / MARKET / SL / SLM
  return (orderType || "MARKET").toUpperCase();
}

function toPlaceOrderSide(x: any): PlaceOrderSide | undefined {
  const s = String(x ?? "").toUpperCase();
  if (s === "BUY") return "BUY";
  if (s === "SELL") return "SELL";

  // some APIs return "B"/"S"
  if (s === "B") return "BUY";
  if (s === "S") return "SELL";

  return undefined;
}

export class AliceBlueAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "ALICEBLUE";
  readonly authType: BrokerAuthType = "OAUTH_AUTHCODE" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: AliceBlueCreds, client?: AxiosInstance) {
    if (!creds?.appCode?.trim() || !creds?.apiSecret?.trim() || !creds?.baseUrl?.trim()) {
      throw new BrokerError("AliceBlueAdapter requires appCode, apiSecret, baseUrl", {
        statusCode: 500,
        code: "BROKER_CONFIG_MISSING",
      });
    }

    this.client =
      client ??
      axios.create({
        baseURL: creds.baseUrl.replace(/\/+$/, ""),
        timeout: 30_000,
        validateStatus: () => true,
      });
  }

  private async req<T>(
    method: "GET" | "POST",
    path: string,
    body?: any,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await this.client.request({
      method,
      url: path,
      data: body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(headers || {}),
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new BrokerAuthError("AliceBlue auth failed", res.data);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("AliceBlue request failed", {
        status: res.status,
        data: res.data,
      });
    }

    return res.data as T;
  }

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    // redirect user to: https://ant.aliceblueonline.com/?appcode=<AppCode>
    return `${this.creds.baseUrl.replace(/\/+$/, "")}/?appcode=${encodeURIComponent(this.creds.appCode)}`;
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    // ✅ FIX: authCode must come from callback "authCode"/"auth_code" or params.code
    const authCode = String(
      params.code ??
        params.callbackParams["authCode"] ??
        params.callbackParams["auth_code"] ??
        "",
    ).trim();

    const aliceUserId = String(
      params.callbackParams["userId"] ??
        params.callbackParams["user_id"] ??
        "",
    ).trim();

    if (!authCode || !aliceUserId) {
      throw new BrokerError("AliceBlue requires authCode + userId from callback", {
        statusCode: 400,
        code: "AUTH_INVALID",
      });
    }

    // checksum = sha256(userId + authCode + apiSecret)
    const checkSum = sha256Hex(`${aliceUserId}${authCode}${this.creds.apiSecret}`);

    // POST getUserDetails to obtain userSession
    const data = await this.req<any>(
      "POST",
      "/open-api/od/v1/vendor/getUserDetails",
      { checkSum },
    );

    const userSession: string | undefined = data?.userSession;
    if (!userSession) {
      throw new BrokerUpstreamError("AliceBlue getUserDetails: userSession missing", data);
    }

    return {
      userId: params.userId, // your platform user id
      broker: "ALICEBLUE",
      accessToken: userSession,
      meta: {
        aliceUserId,
        clientId: data?.clientId,
        raw: data,
      },
    };
  }

  private authHeaders(session: BrokerSession) {
    return { Authorization: `Bearer ${session.accessToken}` };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    if (!order.exchange) {
      throw new BrokerError("exchange is required", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const instrumentId = extractInstrumentId(order.symbol);

    // placeorder expects array of orders
    const payload = [
      {
        exchange: String(order.exchange).toUpperCase(),
        instrumentId,
        transactionType: String(order.side).toUpperCase(),
        quantity: order.quantity,
        product: mapProduct(order.product),
        orderComplexity: "REGULAR",
        orderType: mapOrderType(order.orderType),
        validity: (order.validity || "DAY").toUpperCase(),
        price: order.price != null ? String(order.price) : "0",
        slTriggerPrice: order.triggerPrice != null ? String(order.triggerPrice) : "0",
        disclosedQuantity: order.disclosedQuantity != null ? String(order.disclosedQuantity) : "0",
        orderTag: order.clientOrderId ? String(order.clientOrderId).slice(0, 20) : "",
      },
    ];

    const data = await this.req<any>(
      "POST",
      "/open-api/od/v1/orders/placeorder",
      payload,
      this.authHeaders(session),
    );

    const orderId: string | undefined = data?.result?.[0]?.brokerOrderId;
    if (!orderId) {
      throw new BrokerUpstreamError("AliceBlue placeorder: brokerOrderId missing", data);
    }

    return { broker: "ALICEBLUE", orderId, raw: data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req.orderId) {
      throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const payload: any = { brokerOrderId: req.orderId };
    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = String(req.price);
    if (typeof req.triggerPrice === "number") payload.slTriggerPrice = req.triggerPrice;
    if (req.validity) payload.validity = String(req.validity).toUpperCase();

    if (Object.keys(payload).length === 1) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const data = await this.req<any>(
      "POST",
      "/open-api/od/v1/orders/modify",
      payload,
      this.authHeaders(session),
    );

    return { broker: "ALICEBLUE", orderId: req.orderId, raw: data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req.orderId) {
      throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const data = await this.req<any>(
      "POST",
      "/open-api/od/v1/orders/cancel",
      { brokerOrderId: req.orderId },
      this.authHeaders(session),
    );

    return { broker: "ALICEBLUE", orderId: req.orderId, raw: data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const data = await this.req<any>(
      "GET",
      "/open-api/od/v1/orders/book",
      undefined,
      this.authHeaders(session),
    );

    const rows: any[] = Array.isArray(data?.result) ? data.result : [];

    return rows.map((o: any) => ({
      orderId: String(o.brokerOrderId ?? ""),
      symbol: o.instrumentId != null ? `instrumentId:${o.instrumentId}` : "",
      exchange: o.exchange ?? undefined,
      side: toPlaceOrderSide(o.transactionType), // ✅ FIXED TYPE
      status: String(o.orderStatus ?? ""),
      orderType: o.orderType ?? undefined,
      product: o.product ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filledQuantity != null ? Number(o.filledQuantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.slTriggerPrice != null ? Number(o.slTriggerPrice) : undefined,
      averagePrice: o.averageTradedPrice != null ? Number(o.averageTradedPrice) : undefined,
      placedAt: o.orderTime ?? undefined,
      updatedAt: o.brokerUpdateTime ?? undefined,
      raw: o,
    }));
  }

  async getPositions(_session: BrokerSession): Promise<Position[]> {
    return [];
  }

  async getHoldings(_session: BrokerSession): Promise<Holding[]> {
    return [];
  }
}
