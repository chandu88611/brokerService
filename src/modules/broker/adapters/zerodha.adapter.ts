// src/modules/broker/adapters/zerodha.adapter.ts

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
  normalizeSide,
} from "../core/types";
import { BrokerAuthError, BrokerError, BrokerUpstreamError } from "../core/errors";

type ZerodhaAppCreds = {
  apiKey: string;
  apiSecret: string;
  redirectUri?: string;
};

const KITE_BASE = "https://api.kite.trade";
const KITE_VERSION = "3";

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function parseSymbol(symbol: string, exchange?: string) {
  const s = (symbol || "").trim();
  if (!s) throw new BrokerError("symbol is required", { statusCode: 400, code: "ORDER_INVALID" });

  // "NSE:INFY"
  if (s.includes(":")) {
    const [ex, ts] = s.split(":");
    if (!ex || !ts) throw new BrokerError("Invalid symbol format", { statusCode: 400, code: "ORDER_INVALID" });
    return { exchange: ex.toUpperCase(), tradingsymbol: ts.toUpperCase() };
  }

  // "INFY" + exchange passed separately
  if (!exchange) {
    throw new BrokerError("exchange is required when symbol is not EXCHANGE:SYMBOL", {
      statusCode: 400,
      code: "ORDER_INVALID",
    });
  }

  return { exchange: exchange.toUpperCase(), tradingsymbol: s.toUpperCase() };
}

function mapOrderType(orderType: PlaceOrderRequest["orderType"]) {
  // Zerodha expects: MARKET | LIMIT | SL | SLM
  switch (orderType) {
    case "MARKET":
      return "MARKET";
    case "LIMIT":
      return "LIMIT";
    case "SL":
      return "SL";
    case "SL-M":
      return "SLM";
    default:
      return "MARKET";
  }
}

function mapProduct(product?: PlaceOrderRequest["product"]) {
  return (product || "MIS").toUpperCase();
}

function mapValidity(validity?: PlaceOrderRequest["validity"]) {
  return (validity || "DAY").toUpperCase();
}

export class ZerodhaAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "ZERODHA";
  // ✅ Zerodha flow gives request_token
  readonly authType: BrokerAuthType = "REQUEST_TOKEN";

  private client: AxiosInstance;

  constructor(private creds: ZerodhaAppCreds, client?: AxiosInstance) {
    if (!creds?.apiKey?.trim() || !creds?.apiSecret?.trim()) {
      throw new BrokerError("ZerodhaAdapter requires apiKey & apiSecret", {
        statusCode: 500,
        code: "BROKER_CONFIG_MISSING",
      });
    }

    this.client =
      client ??
      axios.create({
        baseURL: KITE_BASE,
        timeout: 30_000,
        validateStatus: () => true,
      });
  }

  private authHeaders(accessToken: string) {
    return {
      "X-Kite-Version": KITE_VERSION,
      Authorization: `token ${this.creds.apiKey}:${accessToken}`,
    };
  }

  async getLoginUrl(params: LoginUrlParams): Promise<string> {
    const url = new URL("https://kite.zerodha.com/connect/login");
    url.searchParams.set("v", "3");
    url.searchParams.set("api_key", this.creds.apiKey);

    if (params.state) url.searchParams.set("state", params.state);
    const ru = params.redirectUri || this.creds.redirectUri;
    if (ru) url.searchParams.set("redirect_uri", ru);

    return url.toString();
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    const requestToken =
      params.callbackParams["request_token"] ||
      params.callbackParams["requestToken"] ||
      params.callbackParams["token"];

    if (!requestToken) {
      throw new BrokerAuthError("Missing request_token in Zerodha callback params", {
        callbackParams: params.callbackParams,
      });
    }

    // checksum = sha256(api_key + request_token + api_secret)
    const checksum = sha256Hex(`${this.creds.apiKey}${requestToken}${this.creds.apiSecret}`);

    const res = await this.client.post(
      "/session/token",
      new URLSearchParams({
        api_key: this.creds.apiKey,
        request_token: String(requestToken),
        checksum,
      }),
      {
        headers: {
          "X-Kite-Version": KITE_VERSION,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha token exchange unauthorized", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha token exchange failed", { status: res.status, data: res.data });
    }

    const data = res.data?.data;
    const accessToken: string | undefined = data?.access_token;
    if (!accessToken) throw new BrokerUpstreamError("Zerodha token exchange: access_token missing", res.data);

    return {
      userId: params.userId,
      broker: "ZERODHA",
      accessToken,
      meta: {
        kiteUserId: data?.user_id,
        publicToken: data?.public_token,
        loginTime: data?.login_time,
        raw: data,
      },
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    const { exchange, tradingsymbol } = parseSymbol(order.symbol, order.exchange);
    const order_type = mapOrderType(order.orderType);

    const payload: Record<string, any> = {
      variety: "regular",
      exchange,
      tradingsymbol,
      transaction_type: order.side,
      quantity: order.quantity,
      order_type,
      product: mapProduct(order.product),
      validity: mapValidity(order.validity),
    };

    // LIMIT needs price
    if (order_type === "LIMIT") {
      if (typeof order.price !== "number") {
        throw new BrokerError("price is required for LIMIT", { statusCode: 400, code: "ORDER_INVALID" });
      }
      payload.price = order.price;
    }

    // SL/SLM needs trigger_price; SL also needs price
    if (order_type === "SL" || order_type === "SLM") {
      if (typeof order.triggerPrice !== "number") {
        throw new BrokerError("triggerPrice is required for SL/SL-M", { statusCode: 400, code: "ORDER_INVALID" });
      }
      payload.trigger_price = order.triggerPrice;

      if (order_type === "SL") {
        if (typeof order.price !== "number") {
          throw new BrokerError("price is required for SL", { statusCode: 400, code: "ORDER_INVALID" });
        }
        payload.price = order.price;
      }
    }

    if (typeof order.disclosedQuantity === "number") payload.disclosed_quantity = order.disclosedQuantity;
    if (order.clientOrderId) payload.tag = String(order.clientOrderId).slice(0, 20);

    const res = await this.client.post("/orders/regular", new URLSearchParams(payload), {
      headers: {
        ...this.authHeaders(session.accessToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha place order failed", { status: res.status, data: res.data });
    }

    const orderId: string | undefined = res.data?.data?.order_id;
    if (!orderId) throw new BrokerUpstreamError("Zerodha place order: order_id missing", res.data);

    return { broker: "ZERODHA", orderId, raw: res.data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: Record<string, any> = {};
    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = req.price;
    if (typeof req.triggerPrice === "number") payload.trigger_price = req.triggerPrice;
    if (req.validity) payload.validity = mapValidity(req.validity);

    if (Object.keys(payload).length === 0) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const res = await this.client.put(`/orders/regular/${encodeURIComponent(req.orderId)}`, new URLSearchParams(payload), {
      headers: {
        ...this.authHeaders(session.accessToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha modify order failed", { status: res.status, data: res.data });
    }

    const orderId: string = res.data?.data?.order_id || req.orderId;
    return { broker: "ZERODHA", orderId, raw: res.data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const res = await this.client.delete(`/orders/regular/${encodeURIComponent(req.orderId)}`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha cancel order failed", { status: res.status, data: res.data });
    }

    const orderId: string = res.data?.data?.order_id || req.orderId;
    return { broker: "ZERODHA", orderId, raw: res.data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const res = await this.client.get("/orders", {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha getOrders failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
    return rows.map((o: any) => ({
      orderId: String(o.order_id ?? ""),
      symbol: o.tradingsymbol ? `${o.exchange}:${o.tradingsymbol}` : String(o.tradingsymbol || ""),
      exchange: o.exchange ?? undefined,
      // ✅ FIX: normalize side
      side: normalizeSide(o.transaction_type),
      status: String(o.status || ""),
      orderType: o.order_type ?? undefined,
      product: o.product ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filled_quantity != null ? Number(o.filled_quantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.trigger_price != null ? Number(o.trigger_price) : undefined,
      averagePrice: o.average_price != null ? Number(o.average_price) : undefined,
      placedAt: o.order_timestamp || undefined,
      updatedAt: o.exchange_timestamp || undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const res = await this.client.get("/portfolio/positions", {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha getPositions failed", { status: res.status, data: res.data });
    }

    const net: any[] = Array.isArray(res.data?.data?.net) ? res.data.data.net : [];
    return net.map((p: any) => ({
      symbol: p.tradingsymbol ? `${p.exchange}:${p.tradingsymbol}` : String(p.tradingsymbol || ""),
      quantity: p.quantity != null ? Number(p.quantity) : undefined,
      averagePrice: p.average_price != null ? Number(p.average_price) : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      raw: p,
    }));
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const res = await this.client.get("/portfolio/holdings", {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zerodha auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zerodha getHoldings failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
    return rows.map((h: any) => ({
      symbol: h.tradingsymbol ? `${h.exchange}:${h.tradingsymbol}` : String(h.tradingsymbol || ""),
      quantity: h.quantity != null ? Number(h.quantity) : undefined,
      averagePrice: h.average_price != null ? Number(h.average_price) : undefined,
      ltp: h.last_price != null ? Number(h.last_price) : undefined,
      raw: h,
    }));
  }
  
}
