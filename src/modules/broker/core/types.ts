// src/modules/broker/core/types.ts

export type IndiaBroker =
  | "ZERODHA"
  | "UPSTOX"
  | "FYERS"
  | "ANGELONE"
  | "DHAN"
  | "ZEBU"
  | "ALICEBLUE"
  | "DELTA_EXCHANGE";

// Auth styles (login flow varies)
export type BrokerAuthType =
  | "OAUTH_AUTHCODE"
  | "REQUEST_TOKEN"
  | "API_KEY"
  | "NONE";

export type PlaceOrderSide = "BUY" | "SELL";

export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M" | string;
export type ProductType = "CNC" | "MIS" | "NRML" | string;

export type BrokerSession = {
  userId: number;
  broker: IndiaBroker;

  // For most brokers: access token used in Authorization headers
  accessToken: string;

  // Optional refresh token etc.
  refreshToken?: string;
  expiresAt?: string | number; // ISO or epoch
  meta?: Record<string, any>;
};

// When frontend/broker redirects back, we read params from query/body
export type ExchangeTokenParams = {
  userId: number;
  broker: IndiaBroker;

  // ✅ unified raw callback params
  callbackParams: Record<string, string | undefined>;

  // ✅ convenience aliases (optional; adapters can use if they want)
  code?: string;
  authCode?: string;
  requestToken?: string;
  state?: string;
};

export type LoginUrlParams = {
  userId: number;
  broker: IndiaBroker;
  state?: string;
  redirectUri?: string;
};

// ----------- Orders / portfolio -----------

export type PlaceOrderRequest = {
  symbol: string; // broker symbol OR instrument id (depending adapter)
  exchange?: string;
  side: PlaceOrderSide;

  quantity: number;

  orderType?: OrderType;
  product?: ProductType;

  price?: number;
  triggerPrice?: number;
  disclosedQuantity?: number;
  validity?: string;

  clientOrderId?: string;

  // allow extra broker-specific data without TS breaking
  meta?: Record<string, any>;
};

export type PlaceOrderResponse = {
  broker: IndiaBroker;
  orderId: string;
  raw?: any;
};

export type ModifyOrderRequest = {
  orderId: string;
  quantity?: number;
  price?: number;
  triggerPrice?: number;
  validity?: string;
  meta?: Record<string, any>;
};

export type ModifyOrderResponse = {
  broker: IndiaBroker;
  orderId: string;
  raw?: any;
};

export type CancelOrderRequest = {
  orderId: string;
};

export type CancelOrderResponse = {
  broker: IndiaBroker;
  orderId: string;
  raw?: any;
};

export type Order = {
  orderId: string;
  symbol: string;

  exchange?: string;
  side?: PlaceOrderSide;

  status?: string;
  orderType?: string;
  product?: string;

  quantity?: number;
  filledQuantity?: number;

  price?: number;
  triggerPrice?: number;
  averagePrice?: number;

  placedAt?: string;
  updatedAt?: string;

  raw?: any;
};

export type Position = {
  symbol: string;
  quantity?: number;
  averagePrice?: number;
  pnl?: number;
  raw?: any;
};

export type Holding = {
  symbol: string;
  quantity?: number;
  averagePrice?: number;
  ltp?: number;
  raw?: any;
};

// ---------- helpers ----------
export function normalizeSide(x: any): PlaceOrderSide | undefined {
  const v = String(x ?? "").toUpperCase().trim();
  if (v === "BUY" || v === "B") return "BUY";
  if (v === "SELL" || v === "S") return "SELL";
  return undefined;
}
