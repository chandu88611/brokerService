// src/modules/broker/adapters/fyers.adapter.ts

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
  Position,
} from "../core/types";
import { BrokerAuthError, BrokerError, BrokerUpstreamError } from "../core/errors";

type FyersCreds = {
  /**
   * FYERS client_id looks like: "XXXXXX-100"
   * secretKey is your app secret.
   */
  clientId: string;
  secretKey: string;
  redirectUri: string;

  /**
   * FYERS base URL varies (t1 / prod).
   * Example: "https://api-t1.fyers.in"
   */
  baseUrl: string;

  /**
   * Use v3 order endpoints first (orders/sync is shown in v3 discussions).
   * You can switch off if needed.
   */
  preferV3?: boolean;
};

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeSymbol(s: string) {
  const v = (s || "").trim();
  if (!v) throw new BrokerError("symbol is required", { statusCode: 400, code: "ORDER_INVALID" });
  // allow "symbol:SBIN-EQ"
  return v.startsWith("symbol:") ? v.slice("symbol:".length) : v;
}

function mapSide(side: PlaceOrderRequest["side"]) {
  // FYERS uses 1=BUY, -1=SELL in many versions
  return side === "BUY" ? 1 : -1;
}

function mapOrderType(orderType: PlaceOrderRequest["orderType"]) {
  // FYERS typical: 1=LIMIT, 2=MARKET, 3=SL, 4=SL-M
  switch (orderType) {
    case "LIMIT":
      return 1;
    case "MARKET":
      return 2;
    case "SL":
      return 3;
    case "SL-M":
      return 4;
    default:
      return 2;
  }
}

function mapProduct(product?: PlaceOrderRequest["product"]) {
  // FYERS: CNC=1, INTRADAY=2, MARGIN=3 (varies); we keep minimal mapping
  const p = (product || "MIS").toUpperCase();
  if (p === "CNC") return "CNC";
  if (p === "MIS") return "INTRADAY";
  if (p === "NRML") return "MARGIN";
  return "INTRADAY";
}

export class FyersAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "FYERS";
  readonly authType: BrokerAuthType = "OAUTH_AUTHCODE" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: FyersCreds, client?: AxiosInstance) {
    if (!creds?.clientId?.trim() || !creds?.secretKey?.trim() || !creds?.redirectUri?.trim() || !creds?.baseUrl?.trim()) {
      throw new BrokerError("FyersAdapter requires clientId, secretKey, redirectUri, baseUrl", {
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

  private async req<T>(method: "GET" | "POST", path: string, body?: any, headers?: Record<string, string>) {
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

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("FYERS auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("FYERS request failed", { status: res.status, data: res.data });
    }
    return res.data as T;
  }

  async getLoginUrl(params: LoginUrlParams): Promise<string> {
    // FYERS generates authcode URL like:
    // https://api-t1.fyers.in/api/v3/generate-authcode?client_id=...&redirect_uri=...&response_type=code&state=...
    // :contentReference[oaicite:3]{index=3}
    const state = encodeURIComponent(params.state || "state");
    const clientId = encodeURIComponent(this.creds.clientId);
    const redirectUri = encodeURIComponent(this.creds.redirectUri);

    return `${this.creds.baseUrl.replace(/\/+$/, "")}/api/v3/generate-authcode?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    // FYERS v3 token exchange is discussed as validate-authcode endpoint :contentReference[oaicite:4]{index=4}
    const authCode = String(params.userId || params.callbackParams["auth_code"] || params.callbackParams["code"] || "").trim();
    if (!authCode) {
      throw new BrokerError("FYERS auth code missing (expected code/auth_code)", { statusCode: 400, code: "AUTH_INVALID" });
    }

    // Many FYERS samples compute SHA-256(appId:secret) as a validation field.
    const appIdHash = sha256Hex(`${this.creds.clientId}:${this.creds.secretKey}`);

    const data = await this.req<any>("POST", "/api/v3/validate-authcode", {
      grant_type: "authorization_code",
      appIdHash,
      code: authCode,
    });

    // Different wrappers exist; we accept a few common shapes.
    const accessToken: string | undefined =
      data?.access_token || data?.data?.access_token || data?.token || data?.data?.token;

    if (!accessToken) {
      throw new BrokerUpstreamError("FYERS validate-authcode: access token missing", data);
    }

    const refreshToken: string | undefined = data?.refresh_token || data?.data?.refresh_token;

    return {
      userId: params.userId,
      broker: "FYERS",
      accessToken,
      meta: { refreshToken, raw: data },
    };
  }

  // --- Orders (minimal, robust) ---

  private authHeaders(session: BrokerSession) {
    return {
      Authorization: `Bearer ${session.accessToken}`,
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    if (!order.exchange) throw new BrokerError("exchange is required for FYERS", { statusCode: 400, code: "ORDER_INVALID" });

    const symbol = normalizeSymbol(order.symbol);

    const payload: any = {
      symbol,
      qty: order.quantity,
      type: mapOrderType(order.orderType),
      side: mapSide(order.side),
      productType: mapProduct(order.product),
      limitPrice: order.price ?? 0,
      stopPrice: order.triggerPrice ?? 0,
      disclosedQty: order.disclosedQuantity ?? 0,
      validity: (order.validity || "DAY").toUpperCase(),
    };

    // FYERS v3 order endpoint is often shown with /orders/sync :contentReference[oaicite:5]{index=5}
    const preferV3 = this.creds.preferV3 !== false;
    const path = preferV3 ? "/api/v3/orders/sync" : "/api/v2/orders";

    const data = await this.req<any>("POST", path, payload, this.authHeaders(session));

    const orderId: string | undefined =
      data?.id || data?.data?.id || data?.orderId || data?.data?.orderId || data?.data?.order_id;

    if (!orderId) throw new BrokerUpstreamError("FYERS place order: orderId missing", data);

    return { broker: "FYERS", orderId: String(orderId), raw: data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: any = {
      id: req.orderId,
    };
    if (typeof req.quantity === "number") payload.qty = req.quantity;
    if (typeof req.price === "number") payload.limitPrice = req.price;
    if (typeof req.triggerPrice === "number") payload.stopPrice = req.triggerPrice;

    if (Object.keys(payload).length === 1) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const preferV3 = this.creds.preferV3 !== false;
    const path = preferV3 ? "/api/v3/orders/sync" : "/api/v2/orders";

    const data = await this.req<any>("POST", path, payload, this.authHeaders(session));

    return { broker: "FYERS", orderId: req.orderId, raw: data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: any = { id: req.orderId };

    const preferV3 = this.creds.preferV3 !== false;
    const path = preferV3 ? "/api/v3/orders/sync" : "/api/v2/orders";

    const data = await this.req<any>("POST", path, payload, this.authHeaders(session));

    return { broker: "FYERS", orderId: req.orderId, raw: data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const preferV3 = this.creds.preferV3 !== false;
    const path = preferV3 ? "/api/v3/orders" : "/api/v2/orders";

    const data = await this.req<any>("GET", path, undefined, this.authHeaders(session));

    const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.orderBook) ? data.orderBook : Array.isArray(data) ? data : [];

    return rows.map((o: any) => ({
      orderId: String(o.id ?? o.orderId ?? o.order_id ?? ""),
      symbol: String(o.symbol ?? ""),
      exchange: undefined,
      side: o.side === 1 || o.side === "BUY" ? "BUY" : "SELL",
      status: String(o.status ?? o.orderStatus ?? ""),
      orderType: undefined,
      product: undefined,
      quantity: o.qty != null ? Number(o.qty) : undefined,
      filledQuantity: o.filledQty != null ? Number(o.filledQty) : undefined,
      price: o.limitPrice != null ? Number(o.limitPrice) : undefined,
      triggerPrice: o.stopPrice != null ? Number(o.stopPrice) : undefined,
      averagePrice: o.avgPrice != null ? Number(o.avgPrice) : undefined,
      placedAt: o.orderDateTime ?? o.created_at ?? undefined,
      updatedAt: o.updated_at ?? undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const preferV3 = this.creds.preferV3 !== false;
    const path = preferV3 ? "/api/v3/positions" : "/api/v2/positions";

    const data = await this.req<any>("GET", path, undefined, this.authHeaders(session));

    const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

    return rows.map((p: any) => ({
      symbol: String(p.symbol ?? ""),
      exchange: undefined,
      quantity: p.netQty != null ? Number(p.netQty) : p.qty != null ? Number(p.qty) : 0,
      avgPrice: p.avgPrice != null ? Number(p.avgPrice) : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      product: undefined,
      raw: p,
    }));
  }

  async getHoldings(_session: BrokerSession): Promise<Holding[]> {
    // FYERS holdings endpoint exists, but we keep empty until you want it wired.
    return [];
  }
}
