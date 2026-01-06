// // src/modules/broker/services/BrokerSessionService.ts

// import { BrokerError } from "../core/errors";
// import { BrokerSession, IndiaBroker } from "../core/types";

// export interface BrokerStorage {
//   saveSession(session: BrokerSession): Promise<void>;
//   getSession(userId: number, broker: IndiaBroker): Promise<BrokerSession | null>;
//   deleteSession(userId: number, broker: IndiaBroker): Promise<void>;
// }

// /**
//  * In-memory implementation (DEV ONLY)
//  * Later: replace with DB-backed implementation
//  */
// export class InMemoryBrokerStorage implements BrokerStorage {
//   private sessions = new Map<string, BrokerSession>();

//   private key(userId: number, broker: IndiaBroker) {
//     return `${userId}:${broker}`;
//   }

//   async saveSession(session: BrokerSession): Promise<void> {
//     this.sessions.set(this.key(session.userId, session.broker), { ...session });
//   }

//   async getSession(userId: number, broker: IndiaBroker): Promise<BrokerSession | null> {
//     return this.sessions.get(this.key(userId, broker)) ?? null;
//   }

//   async deleteSession(userId: number, broker: IndiaBroker): Promise<void> {
//     this.sessions.delete(this.key(userId, broker));
//   }
// }

// export class BrokerSessionService {
//   constructor(private storage: BrokerStorage) {}

//   async saveSession(session: BrokerSession) {
//     await this.storage.saveSession(session);
//   }

//   async disconnect(userId: number, broker: IndiaBroker) {
//     await this.storage.deleteSession(userId, broker);
//   }

//   async requireSession(userId: number, broker: IndiaBroker): Promise<BrokerSession> {
//     const s = await this.storage.getSession(userId, broker);
//     if (!s) {
//       throw new BrokerError(`No active session for ${broker}`, {
//         statusCode: 400,
//         code: "SESSION_MISSING",
//       });
//     }
//     return s;
//   }

//   async maybeRefresh(session: BrokerSession): Promise<BrokerSession> {
//     // add refresh logic later where applicable
//     return session;
//   }
// }
// src/modules/broker/services/BrokerSessionService.ts

import { BrokerError } from "../core/errors";
import { BrokerSession, IndiaBroker } from "../core/types";

export interface BrokerSessionStorage {
  saveSession(session: BrokerSession): Promise<void>;
  getSession(userId: number, broker: IndiaBroker): Promise<BrokerSession | null>;
  deleteSession(userId: number, broker: IndiaBroker): Promise<void>;
}

/**
 * In-memory implementation (DEV ONLY)
 */
export class InMemoryBrokerSessionStorage implements BrokerSessionStorage {
  private sessions = new Map<string, BrokerSession>();

  private key(userId: number, broker: IndiaBroker) {
    return `${userId}:${broker}`;
  }

  async saveSession(session: BrokerSession): Promise<void> {
    this.sessions.set(this.key(session.userId, session.broker), { ...session });
  }

  async getSession(userId: number, broker: IndiaBroker): Promise<BrokerSession | null> {
    return this.sessions.get(this.key(userId, broker)) ?? null;
  }

  async deleteSession(userId: number, broker: IndiaBroker): Promise<void> {
    this.sessions.delete(this.key(userId, broker));
  }
}

export class BrokerSessionService {
  constructor(private storage: BrokerSessionStorage) {}

  async saveSession(session: BrokerSession) {
    await this.storage.saveSession(session);
  }

  async disconnect(userId: number, broker: IndiaBroker) {
    await this.storage.deleteSession(userId, broker);
  }

  async requireSession(userId: number, broker: IndiaBroker): Promise<BrokerSession> {
    const s = await this.storage.getSession(userId, broker);
    if (!s) {
      throw new BrokerError(`No active session for ${broker}`, {
        statusCode: 400,
        code: "SESSION_MISSING",
      });
    }
    return s;
  }

  async maybeRefresh(session: BrokerSession): Promise<BrokerSession> {
    // Later: refresh tokens for brokers that support it
    return session;
  }
}
