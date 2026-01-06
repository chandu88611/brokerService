// src/modules/broker/adapters/upstox.adapter.ts

import axios, { AxiosInstance } from "axios";

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

type UpstoxAppCreds = {
  clientId: string; // Upstox "api key"
  clientSecret: string;
  redirectUri: string;
};

const AUTH_BASE = "https://api.upstox.com/v2";
const API_BASE = "https://api.upstox.com/v2";
const HFT_BASE = "https://api-hft.upstox.com/v2";

function mapOrderType(orderType: PlaceOrderRequest["orderType"]) {
  // Upstox supports: MARKET, LIMIT, SL, SL-M
  switch (orderType) {
    case "MARKET":
      return "MARKET";
    case "LIMIT":
      return "LIMIT";
    case "SL":
      return "SL";
    case "SL-M":
      return "SL-M";
    default:
      return "MARKET";
  }
}

function mapValidity(validity?: PlaceOrderRequest["validity"]) {
  // DAY / IOC
  return (validity || "DAY").toUpperCase();
}

function mapProduct(product?: PlaceOrderRequest["product"]) {
  // Upstox uses: I (Intraday), D (Delivery), MTF
  const p = (product || "MIS").toUpperCase();
  if (p === "CNC") return "D";
  if (p === "MIS") return "I";
  if (p === "NRML") return "I";
  return "I";
}

function instrumentTokenFromOrder(order: PlaceOrderRequest) {
  /**
   * Upstox requires `instrument_token` like "NSE_EQ|INE669E01016".
   * We treat `order.symbol` as instrument_token for Upstox adapter.
   */
  const tok = (order.symbol || "").trim();
  if (!tok) {
    throw new BrokerError("symbol (instrument_token) is required for Upstox", {
      statusCode: 400,
      code: "ORDER_INVALID",
    });
  }
  return tok;
}

export class UpstoxAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "UPSTOX";
  // ✅ align with our core types
  readonly authType: BrokerAuthType = "OAUTH_AUTHCODE";

  private client: AxiosInstance;

  constructor(private creds: UpstoxAppCreds, client?: AxiosInstance) {
    if (!creds?.clientId?.trim() || !creds?.clientSecret?.trim() || !creds?.redirectUri?.trim()) {
      throw new BrokerError("UpstoxAdapter requires clientId, clientSecret, redirectUri", {
        statusCode: 500,
        code: "BROKER_CONFIG_MISSING",
      });
    }

    this.client =
      client ??
      axios.create({
        timeout: 30_000,
        validateStatus: () => true,
      });
  }

  private authHeaders(accessToken: string) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
  }

  async getLoginUrl(params: LoginUrlParams): Promise<string> {
    const u = new URL(`${AUTH_BASE}/login/authorization/dialog`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.creds.clientId);
    u.searchParams.set("redirect_uri", params.redirectUri || this.creds.redirectUri);
    if (params.state) u.searchParams.set("state", params.state);
    return u.toString();
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    const code =
      params.callbackParams["code"] ||
      params.callbackParams["auth_code"] ||
      params.callbackParams["authorization_code"];

    if (!code) {
      throw new BrokerAuthError("Missing code in Upstox callback params", {
        callbackParams: params.callbackParams,
      });
    }

    const body = new URLSearchParams({
      code: String(code),
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      redirect_uri: this.creds.redirectUri,
      grant_type: "authorization_code",
    });

    const res = await this.client.post(`${AUTH_BASE}/login/authorization/token`, body, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new BrokerAuthError("Upstox token exchange unauthorized", res.data);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox token exchange failed", { status: res.status, data: res.data });
    }

    const accessToken: string | undefined = res.data?.access_token;
    if (!accessToken) {
      throw new BrokerUpstreamError("Upstox token exchange: access_token missing", res.data);
    }

    return {
      userId: params.userId,
      broker: "UPSTOX",
      accessToken,
      meta: {
        tokenType: res.data?.token_type,
        expiresIn: res.data?.expires_in,
        scope: res.data?.scope,
        raw: res.data,
      },
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    const instrument_token = instrumentTokenFromOrder(order);

    const payload: Record<string, any> = {
      quantity: order.quantity,
      product: mapProduct(order.product),
      validity: mapValidity(order.validity),
      price: order.price ?? 0,
      tag: order.clientOrderId ? String(order.clientOrderId).slice(0, 20) : undefined,
      instrument_token,
      order_type: mapOrderType(order.orderType),
      transaction_type: order.side, // BUY / SELL
      disclosed_quantity: order.disclosedQuantity ?? 0,
      trigger_price: order.triggerPrice,
      is_amo: false,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const res = await this.client.post(`${HFT_BASE}/order/place`, payload, {
      headers: {
        ...this.authHeaders(session.accessToken),
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox place order failed", { status: res.status, data: res.data });
    }

    const orderId: string | undefined = res.data?.data?.order_id;
    if (!orderId) throw new BrokerUpstreamError("Upstox place order: order_id missing", res.data);

    return { broker: "UPSTOX", orderId, raw: res.data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: Record<string, any> = { order_id: req.orderId };

    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = req.price;
    if (typeof req.triggerPrice === "number") payload.trigger_price = req.triggerPrice;
    if (req.validity) payload.validity = mapValidity(req.validity);

    if (Object.keys(payload).length === 1) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const res = await this.client.put(`${HFT_BASE}/order/modify`, payload, {
      headers: {
        ...this.authHeaders(session.accessToken),
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox modify order failed", { status: res.status, data: res.data });
    }

    const orderId: string = res.data?.data?.order_id || req.orderId;
    return { broker: "UPSTOX", orderId, raw: res.data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const res = await this.client.delete(`${HFT_BASE}/order/cancel`, {
      headers: {
        ...this.authHeaders(session.accessToken),
        "Content-Type": "application/json",
      },
      data: { order_id: req.orderId },
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox cancel order failed", { status: res.status, data: res.data });
    }

    const orderId: string = res.data?.data?.order_id || req.orderId;
    return { broker: "UPSTOX", orderId, raw: res.data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const res = await this.client.get(`${API_BASE}/order/retrieve-all`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox getOrders failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    return rows.map((o: any) => ({
      orderId: String(o.order_id ?? o.orderId ?? ""),
      symbol: String(o.instrument_token ?? o.trading_symbol ?? o.symbol ?? ""),
      exchange: o.exchange ?? undefined,
      // ✅ FIX: normalize side to PlaceOrderSide | undefined
      side: normalizeSide(o.transaction_type ?? o.side),
      status: String(o.status ?? ""),
      orderType: o.order_type ?? undefined,
      product: o.product ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filled_quantity != null ? Number(o.filled_quantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.trigger_price != null ? Number(o.trigger_price) : undefined,
      averagePrice: o.average_price != null ? Number(o.average_price) : undefined,
      placedAt: o.order_timestamp || o.created_at || undefined,
      updatedAt: o.updated_at || undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const res = await this.client.get(`${API_BASE}/portfolio/short-term-positions`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox getPositions failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    // ✅ map to our core Position type
    return rows.map((p: any) => ({
      symbol: String(p.instrument_token ?? p.trading_symbol ?? p.symbol ?? ""),
      quantity: p.quantity != null ? Number(p.quantity) : undefined,
      averagePrice: p.average_price != null ? Number(p.average_price) : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      raw: p,
    }));
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const res = await this.client.get(`${API_BASE}/portfolio/long-term-holdings`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Upstox auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Upstox getHoldings failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    // ✅ map to our core Holding type
    return rows.map((h: any) => ({
      symbol: String(h.instrument_token ?? h.trading_symbol ?? h.symbol ?? ""),
      quantity: h.quantity != null ? Number(h.quantity) : undefined,
      averagePrice: h.average_price != null ? Number(h.average_price) : undefined,
      ltp: h.last_price != null ? Number(h.last_price) : undefined,
      raw: h,
    }));
  }
}
