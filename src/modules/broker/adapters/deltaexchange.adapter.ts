// src/modules/broker/adapters/deltaexchange.adapter.ts

import axios, { AxiosInstance, Method } from "axios";
import crypto from "crypto";

import { IBrokerAdapter } from "../core/IBrokerAdapter";
import {
  BrokerAuthType,
  BrokerSession,
  CancelOrderRequest,
  CancelOrderResponse,
  ExchangeTokenParams,
  Holding,
  LoginUrlParams,
  ModifyOrderRequest,
  ModifyOrderResponse,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Position,
} from "../core/types";
import { BrokerAuthError, BrokerError, BrokerUpstreamError } from "../core/errors";

type DeltaExchangeCreds = {
  apiKey: string;
  apiSecret: string;

  /**
   * Delta has India + Global docs/base domains.
   * Typical: https://api.india.delta.exchange (India)
   * Global docs exist too; keep configurable.
   */
  baseUrl: string; // e.g. "https://api.india.delta.exchange"
};

function hmacSha256Hex(secret: string, msg: string) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function nowUnixSec() {
  return Math.floor(Date.now() / 1000);
}

function safeJsonBody(body: any) {
  if (body == null) return "";
  // Canonical-ish JSON: no spaces helps signature consistency
  return JSON.stringify(body, Object.keys(body).sort(), 0);
}

function toQueryString(q?: Record<string, any>) {
  if (!q) return "";
  const keys = Object.keys(q).filter((k) => q[k] !== undefined && q[k] !== null);
  if (!keys.length) return "";
  keys.sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(q[k]))}`)
    .join("&");
}

/**
 * Delta signature prehash:
 * method + timestamp + requestPath + queryString + body
 * (concatenation) :contentReference[oaicite:1]{index=1}
 */
function buildPrehash(
  method: string,
  timestamp: number,
  requestPath: string,
  queryString: string,
  bodyString: string,
) {
  return `${method.toUpperCase()}${timestamp}${requestPath}${queryString}${bodyString}`;
}

export class DeltaExchangeAdapter implements IBrokerAdapter {
  // Not in IndiaBroker union yet -> cast until you add it
  readonly broker = "DELTA_EXCHANGE" as any;

  // Not in BrokerAuthType union maybe -> cast until you add it
  readonly authType: BrokerAuthType = "HMAC_API_KEY" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: DeltaExchangeCreds, client?: AxiosInstance) {
    if (!creds?.apiKey?.trim() || !creds?.apiSecret?.trim() || !creds?.baseUrl?.trim()) {
      throw new BrokerError("DeltaExchangeAdapter requires apiKey, apiSecret, baseUrl", {
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

  private signedHeaders(method: string, requestPath: string, queryString: string, bodyString: string) {
    const timestamp = nowUnixSec();
    const prehash = buildPrehash(method, timestamp, requestPath, queryString, bodyString);
    const signature = hmacSha256Hex(this.creds.apiSecret, prehash);

    // Required headers: api-key, signature, timestamp :contentReference[oaicite:2]{index=2}
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": this.creds.apiKey,
      signature,
      timestamp: String(timestamp),
      "User-Agent": "broker-api-service/1.0",
    };
  }

  private async signedRequest<T>(
    method: Method,
    requestPath: string, // must start with /v2/...
    query?: Record<string, any>,
    body?: any,
  ): Promise<T> {
    const qs = toQueryString(query);
    const bodyString = body ? safeJsonBody(body) : "";

    const headers = this.signedHeaders(method, requestPath, qs, bodyString);

    const url = qs ? `${requestPath}?${qs}` : requestPath;

    const res = await this.client.request({
      method,
      url,
      headers,
      data: body ?? undefined,
    });

    if (res.status === 401 || res.status === 403) {
      throw new BrokerAuthError("Delta Exchange auth failed", res.data);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Delta Exchange request failed", { status: res.status, data: res.data });
    }

    // Delta usually wraps in { success, result } (varies by endpoint).
    // We normalize: if res.data.result exists -> return it, else return whole body.
    const d = res.data;
    if (d && typeof d === "object" && "result" in d) return d.result as T;
    return d as T;
  }

  // ---- Auth flow ----

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    // Delta uses API keys; no redirect login for server-side execution.
    // Helpful page:
    return "https://www.delta.exchange/algo/delta-exchange-apis";
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    /**
     * Delta does not issue access_token like OAuth. We store a "session" that references API-key mode.
     * If your system expects accessToken string, we can store a marker.
     * Real secret stays in DB, NOT in session.
     */
    return {
      userId: params.userId,
      broker: this.broker,
      accessToken: "API_KEY_MODE",
      meta: { mode: "HMAC_API_KEY" },
    } as any;
  }

  // ---- Trading ----

  async placeOrder(_session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    /**
     * Delta order requires product_id (instrument) rather than "NSE:INFY".
     * Until your core type has productId, we support:
     * - order.symbol = "product_id:27" OR "27"
     */
    const rawSymbol = String(order.symbol || "").trim();
    if (!rawSymbol) throw new BrokerError("symbol is required (use product_id)", { statusCode: 400, code: "ORDER_INVALID" });

    const productId = rawSymbol.startsWith("product_id:")
      ? Number(rawSymbol.replace("product_id:", ""))
      : Number(rawSymbol);

    if (!Number.isFinite(productId)) {
      throw new BrokerError("Delta requires numeric product_id. Pass symbol as '27' or 'product_id:27'", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    const body: any = {
      product_id: productId,
      size: order.quantity, // Delta uses size
      side: String(order.side || "").toLowerCase(), // buy/sell
      order_type: String(order.orderType || "MARKET").toLowerCase(), // market/limit
    };

    // price for limit
    if (String(order.orderType).toUpperCase() === "LIMIT") {
      if (typeof order.price !== "number") {
        throw new BrokerError("price is required for LIMIT", { statusCode: 400, code: "ORDER_INVALID" });
      }
      body.limit_price = order.price;
    }

    // client_order_id support
    if (order.clientOrderId) body.client_order_id = String(order.clientOrderId).slice(0, 36);

    const result: any = await this.signedRequest("POST", "/v2/orders", undefined, body);

    const orderId = result?.id ?? result?.order_id ?? result?.result?.id;
    if (!orderId) throw new BrokerUpstreamError("Delta place order: missing order id", result);

    return { broker: this.broker, orderId: String(orderId), raw: result } as any;
  }

  async modifyOrder(_session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    // Delta commonly uses PATCH /v2/orders/{id}
    const body: any = {};
    if (typeof req.quantity === "number") body.size = req.quantity;
    if (typeof req.price === "number") body.limit_price = req.price;

    if (Object.keys(body).length === 0) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const result: any = await this.signedRequest("PATCH", `/v2/orders/${encodeURIComponent(req.orderId)}`, undefined, body);

    return { broker: this.broker, orderId: String(req.orderId), raw: result } as any;
  }

  async cancelOrder(_session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const result: any = await this.signedRequest("DELETE", `/v2/orders/${encodeURIComponent(req.orderId)}`);

    return { broker: this.broker, orderId: String(req.orderId), raw: result } as any;
  }

  async getOrders(_session: BrokerSession): Promise<Order[]> {
    // GET /v2/orders (optionally states=open) :contentReference[oaicite:3]{index=3}
    const rows: any[] = await this.signedRequest("GET", "/v2/orders");

    if (!Array.isArray(rows)) return [];

    return rows.map((o: any) => ({
      orderId: String(o.id ?? o.order_id ?? ""),
      symbol: o.product_id != null ? `product_id:${o.product_id}` : "",
      exchange: "DELTA",
      side: (o.side || "").toUpperCase(),
      status: String(o.state ?? o.status ?? ""),
      orderType: String(o.order_type || "").toUpperCase(),
      product: "DERIVATIVES",
      quantity: o.size != null ? Number(o.size) : undefined,
      filledQuantity: o.filled_size != null ? Number(o.filled_size) : undefined,
      price: o.limit_price != null ? Number(o.limit_price) : undefined,
      averagePrice: o.average_fill_price != null ? Number(o.average_fill_price) : undefined,
      placedAt: o.created_at || undefined,
      updatedAt: o.updated_at || undefined,
      raw: o,
    })) as any;
  }

  async getPositions(_session: BrokerSession): Promise<Position[]> {
    // Positions endpoint is separate from orders :contentReference[oaicite:4]{index=4}
    const rows: any[] = await this.signedRequest("GET", "/v2/positions");

    if (!Array.isArray(rows)) return [];

    return rows.map((p: any) => ({
      symbol: p.product_id != null ? `product_id:${p.product_id}` : "",
      exchange: "DELTA",
      quantity: p.size != null ? Number(p.size) : 0,
      avgPrice: p.entry_price != null ? Number(p.entry_price) : undefined,
      pnl: p.realized_pnl != null ? Number(p.realized_pnl) : p.unrealized_pnl != null ? Number(p.unrealized_pnl) : undefined,
      product: "DERIVATIVES",
      raw: p,
    })) as any;
  }

  async getHoldings(_session: BrokerSession): Promise<Holding[]> {
    // Delta is derivatives/crypto — no "holdings" like equities.
    return [];
  }
}
