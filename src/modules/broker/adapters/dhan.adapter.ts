// src/modules/broker/adapters/dhan.adapter.ts

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
} from "../core/types";
import { BrokerAuthError, BrokerError, BrokerUpstreamError } from "../core/errors";

type DhanAppCreds = {
  /**
   * Dhan requires client-id header for most APIs.
   * This is your "Client ID" / "App client id" from Dhan developer console.
   */
  clientId: string;
};

const API_BASE = "https://api.dhan.co"; // base domain

export class DhanAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "DHAN";

  /**
   * Dhan commonly uses a long-lived access token generated from console.
   * So auth is basically "paste token" (no redirect).
   *
   * If your BrokerAuthType union doesn't include TOKEN_PASTE, rename accordingly.
   */
  readonly authType: BrokerAuthType = "TOKEN_PASTE" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: DhanAppCreds, client?: AxiosInstance) {
    if (!creds?.clientId?.trim()) {
      throw new BrokerError("DhanAdapter requires clientId", {
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
      "Content-Type": "application/json",
      "client-id": this.creds.clientId,
      "access-token": accessToken,
    };
  }

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    // Dhan token is usually generated from their portal; keep a helpful link.
    // Frontend can show "Open Dhan token page" and user pastes token.
    return "https://dhan.co/";
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    // Dhan flow: user pastes token (or your UI collects it)
    const token =
      params.callbackParams["access_token"] ||
      params.callbackParams["accessToken"] ||
      params.callbackParams["token"];

    if (!token) {
      throw new BrokerAuthError("Missing Dhan access token (paste token required)", {
        callbackParams: params.callbackParams,
      });
    }

    return {
      userId: params.userId,
      broker: "DHAN",
      accessToken: String(token),
      meta: {
        mode: "PASTE_TOKEN",
      },
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    // NOTE: Dhan has its own schema; here we forward a best-effort payload.
    // You can later add a mapper to convert from our unified model to Dhan payload.
    const payload: Record<string, any> = {
      symbol: order.symbol,
      exchange: order.exchange,
      transaction_type: order.side,
      quantity: order.quantity,
      order_type: order.orderType,
      product: order.product,
      validity: order.validity,
      price: order.price,
      trigger_price: order.triggerPrice,
      disclosed_quantity: order.disclosedQuantity,
      tag: order.clientOrderId ? String(order.clientOrderId).slice(0, 20) : undefined,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const res = await this.client.post(`${API_BASE}/orders`, payload, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan place order failed", { status: res.status, data: res.data });
    }

    const orderId: string | undefined =
      res.data?.data?.orderId || res.data?.data?.order_id || res.data?.orderId || res.data?.order_id;

    if (!orderId) throw new BrokerUpstreamError("Dhan place order: orderId missing", res.data);

    return { broker: "DHAN", orderId: String(orderId), raw: res.data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: Record<string, any> = {};
    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = req.price;
    if (typeof req.triggerPrice === "number") payload.trigger_price = req.triggerPrice;
    if (req.validity) payload.validity = req.validity;

    if (Object.keys(payload).length === 0) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const res = await this.client.put(`${API_BASE}/orders/${encodeURIComponent(req.orderId)}`, payload, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan modify order failed", { status: res.status, data: res.data });
    }

    return { broker: "DHAN", orderId: req.orderId, raw: res.data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const res = await this.client.delete(`${API_BASE}/orders/${encodeURIComponent(req.orderId)}`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan cancel order failed", { status: res.status, data: res.data });
    }

    return { broker: "DHAN", orderId: req.orderId, raw: res.data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const res = await this.client.get(`${API_BASE}/orders`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan getOrders failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];

    return rows.map((o: any) => ({
      orderId: String(o.orderId ?? o.order_id ?? o.id ?? ""),
      symbol: String(o.symbol ?? o.tradingSymbol ?? o.instrument ?? ""),
      exchange: o.exchange ?? undefined,
      side: o.transaction_type ?? o.side ?? undefined,
      status: String(o.status ?? ""),
      orderType: o.order_type ?? o.orderType ?? undefined,
      product: o.product ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filled_quantity != null ? Number(o.filled_quantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.trigger_price != null ? Number(o.trigger_price) : undefined,
      averagePrice: o.average_price != null ? Number(o.average_price) : undefined,
      placedAt: o.created_at || o.orderTime || undefined,
      updatedAt: o.updated_at || undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const res = await this.client.get(`${API_BASE}/positions`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan getPositions failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];

    return rows.map((p: any) => ({
      symbol: String(p.symbol ?? p.tradingSymbol ?? p.instrument ?? ""),
      exchange: p.exchange ?? undefined,
      quantity: p.quantity != null ? Number(p.quantity) : 0,
      avgPrice: p.average_price != null ? Number(p.average_price) : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      product: p.product ?? undefined,
      raw: p,
    }));
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const res = await this.client.get(`${API_BASE}/holdings`, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Dhan auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Dhan getHoldings failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];

    return rows.map((h: any) => ({
      symbol: String(h.symbol ?? h.tradingSymbol ?? h.instrument ?? ""),
      exchange: h.exchange ?? undefined,
      quantity: h.quantity != null ? Number(h.quantity) : 0,
      avgPrice: h.average_price != null ? Number(h.average_price) : undefined,
      ltp: h.last_price != null ? Number(h.last_price) : undefined,
      pnl: h.pnl != null ? Number(h.pnl) : undefined,
      raw: h,
    }));
  }
}
