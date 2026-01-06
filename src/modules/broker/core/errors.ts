// src/modules/broker/core/errors.ts

export class BrokerError extends Error {
  statusCode: number;
  code?: string;
  details?: any;

  constructor(message: string, opts?: { statusCode?: number; code?: string; details?: any }) {
    super(message);
    this.name = "BrokerError";
    this.statusCode = opts?.statusCode ?? 500;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export class BrokerAuthError extends BrokerError {
  constructor(message: string, details?: any) {
    super(message, { statusCode: 401, code: "BROKER_AUTH_FAILED", details });
    this.name = "BrokerAuthError";
  }
}

export class BrokerUpstreamError extends BrokerError {
  constructor(message: string, details?: any) {
    super(message, { statusCode: 502, code: "BROKER_UPSTREAM_FAILED", details });
    this.name = "BrokerUpstreamError";
  }
}
