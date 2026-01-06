// src/modules/broker/adapters/angelone.adapter.ts

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

type AngelOneAppCreds = {
  apiKey: string;
  clientCode: string;
  password: string;
  totp: string;
};

const API_BASE = "https://apiconnect.angelone.in";

const ROUTES = {
  loginByPassword: "/rest/auth/angelbroking/user/v1/loginByPassword",
  placeOrder: "/rest/secure/angelbroking/order/v1/placeOrder",
  modifyOrder: "/rest/secure/angelbroking/order/v1/modifyOrder",
  cancelOrder: "/rest/secure/angelbroking/order/v1/cancelOrder",
  getOrderBook: "/rest/secure/angelbroking/order/v1/getOrderBook",
  getPosition: "/rest/secure/angelbroking/order/v1/getPosition",
  getHoldings: "/rest/secure/angelbroking/portfolio/v1/getHolding",
} as const;

function mapProduct(product?: PlaceOrderRequest["product"]) {
  const p = (product || "MIS").toUpperCase();
  if (p === "CNC") return "DELIVERY";
  if (p === "MIS") return "INTRADAY";
  if (p === "NRML") return "CARRYFORWARD";
  return "INTRADAY";
}

function mapOrderType(orderType: PlaceOrderRequest["orderType"]) {
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
  return (validity || "DAY").toUpperCase();
}

function normalizeSymbol(symbol: string) {
  const s = (symbol || "").trim();
  if (!s) throw new BrokerError("symbol is required", { statusCode: 400, code: "ORDER_INVALID" });
  return s;
}

/**
 * Optional hack until we add `instrumentToken` to the common type:
 * Allow symbol formats:
 *   "NSE:INFY" (no token)
 *   "NSE:INFY:3045" (last part is Angel symboltoken)
 */
function extractAngelSymbolToken(symbol: string): { tradingsymbol: string; symboltoken?: string } {
  const s = normalizeSymbol(symbol);

  const parts = s.split(":").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tradingsymbol = parts[1];
    const possibleToken = parts.length >= 3 ? parts[2] : undefined;
    if (possibleToken && /^\d+$/.test(possibleToken)) {
      return { tradingsymbol, symboltoken: possibleToken };
    }
    return { tradingsymbol };
  }

  // if user just sends "INFY" treat as trading symbol
  return { tradingsymbol: s };
}

export class AngelOneAdapter implements IBrokerAdapter {
  readonly broker: IndiaBroker = "ANGELONE";
  readonly authType: BrokerAuthType = "PASSWORD_TOTP" as BrokerAuthType;

  private client: AxiosInstance;

  constructor(private creds: AngelOneAppCreds, client?: AxiosInstance) {
    if (
      !creds?.apiKey?.trim() ||
      !creds?.clientCode?.trim() ||
      !creds?.password?.trim() ||
      !creds?.totp?.trim()
    ) {
      throw new BrokerError("AngelOneAdapter requires apiKey, clientCode, password, totp", {
        statusCode: 500,
        code: "BROKER_CONFIG_MISSING",
      });
    }

    this.client =
      client ??
      axios.create({
        baseURL: API_BASE,
        timeout: 30_000,
        validateStatus: () => true,
      });
  }

  private authHeaders(accessToken: string) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-PrivateKey": this.creds.apiKey,
    };
  }

  async getLoginUrl(_params: LoginUrlParams): Promise<string> {
    return "https://smartapi.angelone.in/publisher-login";
  }

  async exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession> {
    const clientCode = String(params.callbackParams["clientCode"] ?? this.creds.clientCode);
    const password = String(params.callbackParams["password"] ?? this.creds.password);
    const totp = String(params.callbackParams["totp"] ?? this.creds.totp);

    const res = await this.client.post(
      ROUTES.loginByPassword,
      { clientcode: clientCode, password, totp },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-PrivateKey": this.creds.apiKey,
        },
      },
    );

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One login unauthorized", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One login failed", { status: res.status, data: res.data });
    }

    const jwtToken: string | undefined = res.data?.data?.jwtToken;
    if (!jwtToken) throw new BrokerUpstreamError("Angel One login: jwtToken missing", res.data);

    return {
      userId: params.userId,
      broker: "ANGELONE",
      accessToken: jwtToken,
      meta: {
        refreshToken: res.data?.data?.refreshToken,
        feedToken: res.data?.data?.feedToken,
        state: res.data?.data?.state,
        raw: res.data?.data,
      },
    };
  }

  async placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    const { tradingsymbol, symboltoken } = extractAngelSymbolToken(order.symbol);

    if (!order.exchange) {
      throw new BrokerError("exchange is required for Angel One orders", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const payload: Record<string, any> = {
      variety: "NORMAL",
      tradingsymbol,
      // symboltoken is optional here (until common type supports it)
      ...(symboltoken ? { symboltoken } : {}),
      exchange: String(order.exchange).toUpperCase(),
      transactiontype: order.side,
      ordertype: mapOrderType(order.orderType),
      producttype: mapProduct(order.product),
      duration: mapValidity(order.validity),
      quantity: order.quantity,
      price: order.price ?? "0",
      triggerprice: order.triggerPrice ?? "0",
      disclosedquantity: order.disclosedQuantity ?? "0",
      tag: order.clientOrderId ? String(order.clientOrderId).slice(0, 20) : undefined,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const res = await this.client.post(ROUTES.placeOrder, payload, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One place order failed", { status: res.status, data: res.data });
    }

    const orderId: string | undefined = res.data?.data?.orderid || res.data?.data?.uniqueorderid;
    if (!orderId) throw new BrokerUpstreamError("Angel One place order: orderid missing", res.data);

    return { broker: "ANGELONE", orderId: String(orderId), raw: res.data };
  }

  async modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const payload: Record<string, any> = { orderid: req.orderId };
    if (typeof req.quantity === "number") payload.quantity = req.quantity;
    if (typeof req.price === "number") payload.price = String(req.price);
    if (typeof req.triggerPrice === "number") payload.triggerprice = String(req.triggerPrice);
    if (req.validity) payload.duration = mapValidity(req.validity);

    if (Object.keys(payload).length === 1) {
      throw new BrokerError("No modify fields provided", { statusCode: 400, code: "ORDER_INVALID" });
    }

    const res = await this.client.post(ROUTES.modifyOrder, payload, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One modify order failed", { status: res.status, data: res.data });
    }

    const orderId: string = res.data?.data?.orderid || req.orderId;
    return { broker: "ANGELONE", orderId: String(orderId), raw: res.data };
  }

  async cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse> {
    if (!req?.orderId) throw new BrokerError("orderId is required", { statusCode: 400, code: "ORDER_INVALID" });

    const res = await this.client.post(
      ROUTES.cancelOrder,
      { orderid: req.orderId },
      { headers: this.authHeaders(session.accessToken) },
    );

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One cancel order failed", { status: res.status, data: res.data });
    }

    return { broker: "ANGELONE", orderId: req.orderId, raw: res.data };
  }

  async getOrders(session: BrokerSession): Promise<Order[]> {
    const res = await this.client.get(ROUTES.getOrderBook, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One getOrderBook failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    return rows.map((o: any) => ({
      orderId: String(o.orderid ?? o.order_id ?? ""),
      symbol: String(o.tradingsymbol ?? o.symbol ?? ""),
      exchange: o.exchange ?? undefined,
      side: o.transactiontype ?? o.side ?? undefined,
      status: String(o.orderstatus ?? o.status ?? ""),
      orderType: o.ordertype ?? undefined,
      product: o.producttype ?? undefined,
      quantity: o.quantity != null ? Number(o.quantity) : undefined,
      filledQuantity: o.filledshares != null ? Number(o.filledshares) : undefined,
      price: o.price != null ? Number(o.price) : undefined,
      triggerPrice: o.triggerprice != null ? Number(o.triggerprice) : undefined,
      averagePrice: o.averageprice != null ? Number(o.averageprice) : undefined,
      placedAt: o.updatetime || o.ordertime || undefined,
      updatedAt: o.updatetime || undefined,
      raw: o,
    }));
  }

  async getPositions(session: BrokerSession): Promise<Position[]> {
    const res = await this.client.get(ROUTES.getPosition, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One getPosition failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    return rows.map((p: any) => ({
      symbol: String(p.tradingsymbol ?? p.symbol ?? ""),
      exchange: p.exchange ?? undefined,
      quantity: p.netqty != null ? Number(p.netqty) : p.quantity != null ? Number(p.quantity) : 0,
      avgPrice:
        p.avgnetprice != null
          ? Number(p.avgnetprice)
          : p.averageprice != null
            ? Number(p.averageprice)
            : undefined,
      pnl: p.pnl != null ? Number(p.pnl) : undefined,
      product: p.producttype ?? undefined,
      raw: p,
    }));
  }

  async getHoldings(session: BrokerSession): Promise<Holding[]> {
    const res = await this.client.get(ROUTES.getHoldings, {
      headers: this.authHeaders(session.accessToken),
    });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError("Angel One auth failed", res.data);
    if (res.status < 200 || res.status >= 300) {
      throw new BrokerUpstreamError("Angel One getHoldings failed", { status: res.status, data: res.data });
    }

    const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];

    return rows.map((h: any) => ({
      symbol: String(h.tradingsymbol ?? h.symbol ?? ""),
      exchange: h.exchange ?? undefined,
      quantity: h.quantity != null ? Number(h.quantity) : 0,
      avgPrice: h.averageprice != null ? Number(h.averageprice) : undefined,
      ltp: h.ltp != null ? Number(h.ltp) : undefined,
      pnl: h.pnl != null ? Number(h.pnl) : undefined,
      raw: h,
    }));
  }
}
