// src/modules/broker/core/IBrokerAdapter.ts

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
} from "./types";

export interface IBrokerAdapter {
  readonly broker: IndiaBroker;
  readonly authType: BrokerAuthType;

  getLoginUrl(params: LoginUrlParams): Promise<string>;

  exchangeToken(params: ExchangeTokenParams): Promise<BrokerSession>;

  placeOrder(session: BrokerSession, order: PlaceOrderRequest): Promise<PlaceOrderResponse>;
  modifyOrder(session: BrokerSession, req: ModifyOrderRequest): Promise<ModifyOrderResponse>;
  cancelOrder(session: BrokerSession, req: CancelOrderRequest): Promise<CancelOrderResponse>;

  getOrders(session: BrokerSession): Promise<Order[]>;
  getPositions(session: BrokerSession): Promise<Position[]>;
  getHoldings(session: BrokerSession): Promise<Holding[]>;
}
