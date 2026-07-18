// In-memory сессионный сторедж: sessionId → snapshot окружения.
// Оператор с постоянной БД (Neon/Postgres) заменяет реализацию, сохраняя
// интерфейс.

import type { WalletKind } from '../polymarket/signatures.js';

export interface SessionSnapshot {
  sessionId: string;
  walletAddress: string;
  walletKind: WalletKind;
  chainId: number;
  createdAt: number;
  env: {
    okxApiKey: boolean;
    x402PayTo: boolean;
    clobApiKey: boolean;
  };
}

export interface SessionStore {
  save(s: SessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot | null>;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionSnapshot>();
  async save(s: SessionSnapshot): Promise<void> {
    this.map.set(s.sessionId, s);
  }
  async load(sessionId: string): Promise<SessionSnapshot | null> {
    return this.map.get(sessionId) ?? null;
  }
}

export function newSessionId(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function envSnapshot(env: NodeJS.ProcessEnv): SessionSnapshot['env'] {
  return {
    okxApiKey: Boolean(env.OKX_API_KEY),
    x402PayTo: Boolean(env.X402_PAY_TO),
    clobApiKey: Boolean(env.CLOB_API_KEY),
  };
}
