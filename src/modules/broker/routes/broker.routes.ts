// // src/modules/broker/routes/broker.routes.ts

// import { Router } from "express";
// import { createBrokerAuthController } from "../controllers/brokerAuth.controller";
// import { createBrokerOrdersController } from "../controllers/brokerOrders.controller";
// import { BrokerSessionService, InMemoryBrokerStorage } from "../services/BrokerSessionService";
// import { BrokerExecutionService } from "../services/BrokerExecutionService";

// const storage = new InMemoryBrokerStorage();
// const sessionService = new BrokerSessionService(storage);
// const executionService = new BrokerExecutionService(sessionService);

// const authController = createBrokerAuthController({ sessions: sessionService });
// const ordersController = createBrokerOrdersController({ execution: executionService });

// export const brokerRouter = Router();

// /**
//  * Auth
//  * NOTE: requires x-broker-creds header (base64 JSON) in requests
//  */
// brokerRouter.get("/:broker/login-url", authController.getLoginUrl);
// brokerRouter.post("/:broker/callback", authController.callback);
// brokerRouter.post("/:broker/disconnect", authController.disconnect);

// /**
//  * Orders
//  * NOTE: requires x-broker-creds header and an active session saved via callback
//  */
// brokerRouter.post("/:broker/orders/place", ordersController.placeOrder);
// brokerRouter.post("/:broker/orders/modify", ordersController.modifyOrder);
// brokerRouter.post("/:broker/orders/cancel", ordersController.cancelOrder);

// brokerRouter.get("/:broker/orders", ordersController.getOrders);
// brokerRouter.get("/:broker/positions", ordersController.getPositions);
// brokerRouter.get("/:broker/holdings", ordersController.getHoldings);
// src/modules/broker/routes/broker.routes.ts

import { Router } from "express";
import { createBrokerAuthController } from "../controllers/brokerAuth.controller";
import { createBrokerOrdersController } from "../controllers/brokerOrders.controller";
import { BrokerExecutionService } from "../services/BrokerExecutionService";
import { BrokerSessionService, InMemoryBrokerSessionStorage } from "../services/BrokerSessionService";

const storage = new InMemoryBrokerSessionStorage();
const sessionService = new BrokerSessionService(storage);
const executionService = new BrokerExecutionService(sessionService);

const authController = createBrokerAuthController({ sessions: sessionService });
const ordersController = createBrokerOrdersController({ execution: executionService });

export const brokerRouter = Router();

/**
 * Auth
 */
brokerRouter.post("/:broker/login-url", authController.getLoginUrl);
brokerRouter.post("/:broker/callback", authController.callback);
brokerRouter.post("/:broker/disconnect", authController.disconnect);

/**
 * Orders
 */
brokerRouter.post("/:broker/orders/place", ordersController.placeOrder);
brokerRouter.post("/:broker/orders/modify", ordersController.modifyOrder);
brokerRouter.post("/:broker/orders/cancel", ordersController.cancelOrder);

// switched to POST so creds can be in body
brokerRouter.post("/:broker/orders", ordersController.getOrders);
brokerRouter.post("/:broker/positions", ordersController.getPositions);
brokerRouter.post("/:broker/holdings", ordersController.getHoldings);
