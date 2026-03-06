// src/modules/broker/adapters/coindcx.adapter.ts

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
import {
  BrokerAuthError,
  BrokerError,
  BrokerUpstreamError,
} from "../core/errors";

type CoinDCXAppCreds = {
  /**
   * Optional defaults if you want server-side configured API key/secret.
   * Usually for user-linked exchange accounts, these will be pasted by the user
   * and stored in session via exchangeToken().
   */
  apiKey?: string;
  apiSecret?: string;
};

const API_BASE = "https://api.coindcx.com";

type CoinDCXSessionMeta = {
  apiSecret?: string;
  mode?: "PASTE_TOKEN";
};

export class CoinDCXAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "COINDCX" as IndiaBroker;

  /**
   * CoinDCX private APIs use API Key + Secret, typically pasted/generated
   * from CoinDCX API Dashboard.
   */
  readonly authType: BrokerAuthType = "TOKEN_PASTE" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: CoinDCXAppCreds = {}, client?: AxiosInstance) {
    this.client =
      client ??
      axios.create({
        timeout: 30_000,
        validateStatus: () => true,
      });
  }

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    // Helpful page for user to create/manage API key
    return "https://coindcx.com/api-dashboard";
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    /**
     * We treat CoinDCX auth as "paste API key + secret"
     * Expected callbackParams from your UI/backend:
     * {
     *   apiKey: "...",
     *   apiSecret: "..."
     * }
     *
     * Also supports alternate names.
     */
    const apiKey =
      params.callbackParams["apiKey"] ||
      params.callbackParams["key"] ||
      params.callbackParams["access_token"] ||
      params.callbackParams["accessToken"];

    const apiSecret =
      params.callbackParams["apiSecret"] ||
      params.callbackParams["secret"] ||
      params.callbackParams["access_secret"] ||
      params.callbackParams["accessSecret"];

    if (!apiKey || !apiSecret) {
      throw new BrokerAuthError(
        "Missing CoinDCX API key/secret (paste token required)",
        { callbackParams: params.callbackParams }
      );
    }

    return {
      userId: params.userId,
      broker: "COINDCX" as IndiaBroker,
      // store apiKey in accessToken to fit your existing BrokerSession contract
      accessToken: String(apiKey),
      meta: {
        apiSecret: String(apiSecret),
        mode: "PASTE_TOKEN",
      } as CoinDCXSessionMeta,
    };
  }

  private getApiKey(session: BrokerSession): string {
    const apiKey = session?.accessToken || this.creds.apiKey;
    if (!apiKey) {
      throw new BrokerAuthError("CoinDCX API key missing in session");
    }
    return String(apiKey);
  }

  private getApiSecret(session: BrokerSession): string {
    const apiSecret =
      (session?.meta as CoinDCXSessionMeta | undefined)?.apiSecret ||
      this.creds.apiSecret;

    if (!apiSecret) {
      throw new BrokerAuthError("CoinDCX API secret missing in session");
    }
    return String(apiSecret);
  }

  private signBody(body: Record<string, any>, secret: string): string {
    const jsonBody = JSON.stringify(body);
    return crypto.createHmac("sha256", secret).update(jsonBody).digest("hex");
  }

  private authHeaders(session: BrokerSession, body: Record<string, any>) {
    const apiKey = this.getApiKey(session);
    const apiSecret = this.getApiSecret(session);
    const signature = this.signBody(body, apiSecret);

    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-AUTH-APIKEY": apiKey,
      "X-AUTH-SIGNATURE": signature,
    };
  }

  private now(): number {
    return Date.now();
  }

  private clean<T extends Record<string, any>>(obj: T): T {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && v !== null && v !== "") out[k] = v;
    }
    return out as T;
  }

  private mapOrderType(input?: string): string {
    const x = String(input || "").toUpperCase();

    // unified -> CoinDCX
    if (x === "MARKET" || x === "MARKET_ORDER") return "market_order";
    if (x === "LIMIT" || x === "LIMIT_ORDER") return "limit_order";
    if (x === "STOP_LIMIT" || x === "SL") return "stop_limit";
    if (x === "TAKE_PROFIT" || x === "TP") return "take_profit";

    // fallback if caller already passed coindcx style
    if (
      input === "market_order" ||
      input === "limit_order" ||
      input === "stop_limit" ||
      input === "take_profit"
    ) {
      return input;
    }

    // safe default
    return "limit_order";
  }

  private mapSide(input?: string): "buy" | "sell" {
    const x = String(input || "").toUpperCase();
    if (x === "SELL") return "sell";
    return "buy";
  }

  private normalizeMarket(order: PlaceOrderRequest): string {
    /**
     * CoinDCX expects market like BTCINR / ETHUSDT / B-BTC_USDT depending on product.
     * We keep this simple:
     * 1) if caller sends symbol in CoinDCX format, use it
     * 2) else combine symbol + exchange best-effort
     *
     * Prefer passing CoinDCX market directly from your symbol mapper.
     */
    if (order.symbol && /^[A-Z0-9\-_]+$/.test(order.symbol)) {
      return String(order.symbol).toUpperCase();
    }

    throw new BrokerError(
      "CoinDCX requires symbol/market in CoinDCX market format (example: BTCINR, ETHUSDT)",
      { statusCode: 400, code: "ORDER_INVALID" }
    );
  }

  private ensureSuccess(res: any, label: string) {
    if (res.status === 401 || res.status === 403) {
      throw new BrokerAuthError(`CoinDCX auth failed`, res.data);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError(`CoinDCX ${label} failed`, {
        status: res.status,
        data: res.data,
      });
    }
  }

  async placeOrder(
    session: BrokerSession,
    order: PlaceOrderRequest
  ): Promise<PlaceOrderResponse> {
    if (!order?.symbol) {
      throw new BrokerError("symbol is required", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    if (typeof order.quantity !== "number" || order.quantity <= 0) {
      throw new BrokerError("quantity must be > 0", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    const orderType = this.mapOrderType(order.orderType);
    const market = this.normalizeMarket(order);

    if (orderType !== "market_order" && (order.price == null || Number(order.price) <= 0)) {
      throw new BrokerError("price is required for non-market CoinDCX orders", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    const body = this.clean({
      side: this.mapSide(order.side),
      order_type: orderType,
      market,
      price_per_unit:
        orderType === "market_order" ? undefined : Number(order.price),
      total_quantity: Number(order.quantity),
      timestamp: this.now(),
      client_order_id: order.clientOrderId
        ? String(order.clientOrderId)
        : undefined,

      /**
       * Optional:
       * CoinDCX examples sometimes include ecode.
       * Keep it configurable only if you later decide to use it.
       */
      // ecode: "I",
    });

    const res = await this.client.post(`${API_BASE}/exchange/v1/orders/create`, body, {
      headers: this.authHeaders(session, body),
    });

    this.ensureSuccess(res, "place order");

    const row = res.data;
    const orderId =
      row?.id ||
      row?.order_id ||
      row?.data?.id ||
      row?.data?.order_id;

    if (!orderId) {
      throw new BrokerUpstreamError("CoinDCX place order: orderId missing", res.data);
    }

    return {
      broker: "COINDCX" as IndiaBroker,
      orderId: String(orderId),
      raw: res.data,
    };
  }

  async modifyOrder(
    session: BrokerSession,
    req: ModifyOrderRequest
  ): Promise<ModifyOrderResponse> {
    if (!req?.orderId) {
      throw new BrokerError("orderId is required", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    /**
     * CoinDCX spot edit doc clearly supports price edit.
     * Quantity/trigger modify is not handled here.
     */
    if (req.price == null || Number(req.price) <= 0) {
      throw new BrokerError(
        "CoinDCX modifyOrder currently supports price update only; valid price is required",
        { statusCode: 400, code: "ORDER_INVALID" }
      );
    }

    const body = {
      id: String(req.orderId),
      price_per_unit: Number(req.price),
      timestamp: this.now(),
    };

    const res = await this.client.post(`${API_BASE}/exchange/v1/orders/edit`, body, {
      headers: this.authHeaders(session, body),
    });

    this.ensureSuccess(res, "modify order");

    return {
      broker: "COINDCX" as IndiaBroker,
      orderId: String(req.orderId),
      raw: res.data,
    };
  }

  async cancelOrder(
    session: BrokerSession,
    req: CancelOrderRequest
  ): Promise<CancelOrderResponse> {
    if (!req?.orderId) {
      throw new BrokerError("orderId is required", {
        statusCode: 400,
        code: "ORDER_INVALID",
      });
    }

    const body = {
      id: String(req.orderId),
      timestamp: this.now(),
    };

    const res = await this.client.post(`${API_BASE}/exchange/v1/orders/cancel`, body, {
      headers: this.authHeaders(session, body),
    });

    this.ensureSuccess(res, "cancel order");

    return {
      broker: "COINDCX" as IndiaBroker,
      orderId: String(req.orderId),
      raw: res.data,
    };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    /**
     * CoinDCX active_orders endpoint requires market.
     * Since your generic adapter method has no market arg,
     * the closest universal fallback is trade history.
     *
     * If later you want open orders by symbol, add:
     * getOrdersByMarket(session, market)
     */
    const body = {
      limit: 200,
      sort: "desc",
      timestamp: this.now(),
    };

    const res = await this.client.post(
      `${API_BASE}/exchange/v1/orders/trade_history`,
      body,
      {
        headers: this.authHeaders(session, body),
      }
    );

    this.ensureSuccess(res, "getOrders");

    const rows: any[] = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : [];

    return rows.map((o: any) => ({
      orderId: String(o.order_id ?? o.id ?? ""),
      symbol: String(o.symbol ?? o.market ?? ""),
      exchange: undefined,
      side: o.side ?? undefined,
      status: o.status ?? "filled",
      orderType: o.order_type ?? undefined,
      product: "SPOT",
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.quantity != null ? Number(o.quantity) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: undefined,
      averagePrice: o.avg_price != null ? Number(o.avg_price) : o.price != null ? Number(o.price) : undefined,
      placedAt: o.created_at ?? (o.timestamp ? new Date(Number(o.timestamp)).toISOString() : undefined),
      updatedAt: o.updated_at ?? undefined,
      raw: o,
    }));
  }

  async getPositions(_session: BrokerSession): Promise<Position[]> {
    /**
     * This adapter is for basic CoinDCX spot flow.
     * Spot wallet balances are not really "positions" in your broker abstraction.
     * Return empty for now.
     *
     * If you later want futures support, build a separate CoinDCXFuturesAdapter.
     */
    return [];
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const body = {
      timestamp: this.now(),
    };

    const res = await this.client.post(
      `${API_BASE}/exchange/v1/users/balances`,
      body,
      {
        headers: this.authHeaders(session, body),
      }
    );

    this.ensureSuccess(res, "getHoldings");

    const rows: any[] = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : [];

    return rows
      .filter((h: any) => Number(h.balance ?? 0) > 0 || Number(h.locked_balance ?? 0) > 0)
      .map((h: any) => ({
        symbol: String(h.currency ?? ""),
        exchange: "COINDCX",
        quantity: Number(h.balance ?? 0) + Number(h.locked_balance ?? 0),
        avgPrice: undefined,
        ltp: undefined,
        pnl: undefined,
        raw: h,
      }));
  }
}