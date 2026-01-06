// src/modules/broker/adapters/zebu.adapter.ts

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

type ZebuAppCreds = {
  /**
   * Zebu APIs differ depending on what access/program you get (MYNT / Zebu Trade etc).
   * Keep baseUrl configurable so you can plug the right one from DB config.
   */
  baseUrl: string;

  /**
   * Some Zebu APIs require apiKey/appKey, some are token-only.
   * Keep optional so code compiles even if you don’t need it.
   */
  apiKey?: string;
};

export class ZebuAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "ZEBU";

  /**
   * In most real-world setups, Zebu token is generated in their portal / via their login API.
   * For now we support "paste token" flow in our unified backend.
   *
   * If your BrokerAuthType union doesn’t include TOKEN_PASTE,
   * replace it with your equivalent (ex: "MANUAL_TOKEN").
   */
  readonly authType: BrokerAuthType = "TOKEN_PASTE" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: ZebuAppCreds, client?: AxiosInstance) {
    if (!creds?.baseUrl?.trim()) {
      throw new BrokerError("ZebuAdapter requires baseUrl", {
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
    // Many Zebu variants accept Bearer token.
    // Some require apiKey/appKey; include if present.
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(this.creds.apiKey ? { "x-api-key": this.creds.apiKey } : {}),
    };
  }

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    // You can replace this with an actual OAuth/login URL if Zebu provides one for your program.
    return "https://zebuetrade.com/";
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    /**
     * We support paste-token for Zebu initially.
     * UI can send { token: "..." } and we store it in DB via BrokerSessionService.
     */
    const token =
      params.callbackParams["access_token"] ||
      params.callbackParams["accessToken"] ||
      params.callbackParams["token"];

    if (!token) {
      throw new BrokerAuthError("Missing Zebu access token (paste token required)", {
        callbackParams: params.callbackParams,
      });
    }

    return {
      userId: params.userId,
      broker: "ZEBU",
      accessToken: String(token),
      meta: {
        mode: "PASTE_TOKEN",
      },
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    /**
     * Zebu endpoints vary; keep them centralized and easy to change.
     * Replace these paths based on your Zebu API docs.
     */
    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/orders/place`;

    const payload: Record<string, any> = {
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      product: order.product,
      validity: order.validity,
      price: order.price,
      triggerPrice: order.triggerPrice,
      disclosedQuantity: order.disclosedQuantity,
      tag: order.clientOrderId ? String(order.clientOrderId).slice(0, 20) : undefined,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const res = await this.client.post(url, payload, { headers: this.authHeaders(session.accessToken) });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu place order failed", { status: res.status, data: res.data });
    }

    const orderId: string | undefined =
      res.data?.data?.order_id || res.data?.data?.orderId || res.data?.order_id || res.data?.orderId;

    if (!orderId) throw new BrokerUpstreamError("Zebu place order: orderId missing", res.data);

    return { broker: "ZEBU", orderId: String(orderId), raw: res.data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/orders/modify`;

    const payload: Record<string, any> = { orderId: req.orderId };
    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = req.price;
    if (typeof req.triggerPrice === "number") payload.triggerPrice = req.triggerPrice;
    if (req.validity) payload.validity = req.validity;

    if (Object.keys(payload).length === 1) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const res = await this.client.post(url, payload, { headers: this.authHeaders(session.accessToken) });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu modify order failed", { status: res.status, data: res.data });
    }

    return { broker: "ZEBU", orderId: req.orderId, raw: res.data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/orders/cancel`;

    const res = await this.client.post(
      url,
      { orderId: req.orderId },
      { headers: this.authHeaders(session.accessToken) },
    );

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu cancel order failed", { status: res.status, data: res.data });
    }

    return { broker: "ZEBU", orderId: req.orderId, raw: res.data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/orders`;

    const res = await this.client.get(url, { headers: this.authHeaders(session.accessToken) });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu getOrders failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data)
        ? res.data
        : [];

    return rows.map((o: any) => ({
      orderId: String(o.orderId ?? o.order_id ?? o.id ?? ""),
      symbol: String(o.symbol ?? o.tradingSymbol ?? o.instrument ?? ""),
      exchange: o.exchange ?? undefined,
      side: o.side ?? o.transaction_type ?? undefined,
      status: String(o.status ?? ""),
      orderType: o.orderType ?? o.order_type ?? undefined,
      product: o.product ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filledQuantity != null ? Number(o.filledQuantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.triggerPrice != null ? Number(o.triggerPrice) : undefined,
      averagePrice: o.averagePrice != null ? Number(o.averagePrice) : undefined,
      placedAt: o.createdAt || o.orderTime || undefined,
      updatedAt: o.updatedAt || undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/positions`;

    const res = await this.client.get(url, { headers: this.authHeaders(session.accessToken) });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu getPositions failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data)
        ? res.data
        : [];

    return rows.map((p: any) => ({
      symbol: String(p.symbol ?? p.tradingSymbol ?? p.instrument ?? ""),
      exchange: p.exchange ?? undefined,
      quantity: p.quantity != null ? Number(p.quantity) : 0,
      avgPrice: p.avgPrice != null ? Number(p.avgPrice) : p.average_price != null ? Number(p.average_price) : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      product: p.product ?? undefined,
      raw: p,
    }));
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, "")}/holdings`;

    const res = await this.client.get(url, { headers: this.authHeaders(session.accessToken) });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Zebu auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Zebu getHoldings failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data)
        ? res.data
        : [];

    return rows.map((h: any) => ({
      symbol: String(h.symbol ?? h.tradingSymbol ?? h.instrument ?? ""),
      exchange: h.exchange ?? undefined,
      quantity: h.quantity != null ? Number(h.quantity) : 0,
      avgPrice: h.avgPrice != null ? Number(h.avgPrice) : h.average_price != null ? Number(h.average_price) : undefined,
      ltp: h.ltp != null ? Number(h.ltp) : h.last_price != null ? Number(h.last_price) : undefined,
      pnl: h.pnl != null ? Number(h.pnl) : undefined,
      raw: h,
    }));
  }
}
