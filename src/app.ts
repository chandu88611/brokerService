// app.ts (or src/app.ts)
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import crypto from "crypto";

// ✅ add this import
import { brokerRouter } from "./modules/broker/routes/broker.routes";

type ApiError = {
  statusCode: number;
  message: string;
  code?: string;
  details?: any;
};

function getRequestId(req: Request) {
  const fromHeader = req.headers["x-request-id"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  return crypto.randomUUID();
}

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    const rid = getRequestId(req);
    (req as any).requestId = rid;
    res.setHeader("x-request-id", rid);

    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`[${rid}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });

    next();
  });

  const originEnv = (process.env.CORS_ORIGIN || "*").trim();
  const allowAll = originEnv === "*" || originEnv.length === 0;
  const allowList = allowAll ? [] : originEnv.split(",").map((s) => s.trim()).filter(Boolean);

  app.use(
    cors({
      origin: allowAll ? true : allowList,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-request-id", "x-user-id"],
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "brokerApiService",
      env: process.env.NODE_ENV || "development",
    });
  });

  // ✅ MOUNT BROKER ROUTES HERE
  // All endpoints become /broker/:broker/...
  app.use("/broker", brokerRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  // Global error handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const rid = (req as any).requestId || "—";

    const statusCode =
      typeof err?.statusCode === "number"
        ? err.statusCode
        : typeof err?.status === "number"
          ? err.status
          : 500;

    const payload: ApiError = {
      statusCode,
      message: typeof err?.message === "string" ? err.message : "Internal Server Error",
      code: typeof err?.code === "string" ? err.code : undefined,
      details: err?.details,
    };

    console.error(`[${rid}] ERROR`, err);
    res.status(statusCode).json(payload);
  });

  return app;
}
