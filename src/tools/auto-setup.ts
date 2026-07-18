// pm_auto_setup: провизионирование сессии + чек окружения.
// Не требует оплаты x402.

import type { WalletKind } from '../polymarket/signatures.js';
import type { SessionStore } from '../session/store.js';
import { envSnapshot, newSessionId } from '../session/store.js';

export interface AutoSetupInput {
  walletAddress: string;
  walletKind: WalletKind;
  chainId?: number;
}

export interface AutoSetupOutput {
  sessionId: string;
  walletAddress: string;
  walletKind: WalletKind;
  chainId: number;
  env: {
    okxApiKey: boolean;
    x402PayTo: boolean;
    clobApiKey: boolean;
  };
  supportedWalletKinds: WalletKind[];
  notes: string[];
}

const SUPPORTED_KINDS: WalletKind[] = ['eoa', 'poly_proxy', 'poly_gnosis_safe', 'magic_deposit'];

export async function pmAutoSetup(
  input: AutoSetupInput,
  store: SessionStore,
  env: NodeJS.ProcessEnv,
): Promise<AutoSetupOutput> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) {
    throw new Error('walletAddress должен быть 0x + 40 hex');
  }
  if (!SUPPORTED_KINDS.includes(input.walletKind)) {
    throw new Error(`Неподдерживаемый walletKind: ${input.walletKind}`);
  }
  const sessionId = newSessionId();
  const chainId = input.chainId ?? 137;
  const snap = envSnapshot(env);
  await store.save({
    sessionId,
    walletAddress: input.walletAddress,
    walletKind: input.walletKind,
    chainId,
    createdAt: Date.now(),
    env: snap,
  });
  const notes: string[] = [];
  if (!snap.okxApiKey) notes.push('OKX_API_KEY не задан — auto_swap будет работать в stub-режиме');
  if (!snap.x402PayTo) notes.push('X402_PAY_TO не задан — платежи по x402 не пойдут никуда');
  if (!snap.clobApiKey) notes.push('CLOB_API_KEY не задан — pm_place_bet соберёт payload, но не отправит его');
  if (input.walletKind === 'magic_deposit') {
    notes.push('magic_deposit: pm_place_bet использует signatureType=3 и makerMode=true (архитектура CLOB v2)');
  }
  return {
    sessionId,
    walletAddress: input.walletAddress,
    walletKind: input.walletKind,
    chainId,
    env: snap,
    supportedWalletKinds: SUPPORTED_KINDS,
    notes,
  };
}
