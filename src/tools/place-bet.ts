// pm_place_bet: сборка payload'а ордера, при необходимости — swap-quote,
// проверка оплаты x402.

import type { PlaceBetInput, PolymarketClient, PreparedBet } from '../polymarket/client.js';
import type { SwapQuote, SwapRouter } from '../polymarket/swap.js';
import type { SessionStore } from '../session/store.js';
import type { X402ChargeRule, X402Verifier } from '../payment/x402.js';

export interface PlaceBetToolInput extends PlaceBetInput {
  auto_swap?: boolean;
}

export interface PlaceBetToolOutput {
  bet: PreparedBet;
  swap?: SwapQuote;
  payment: {
    charged: string;
    asset: string;
    network: string;
    paymentId: string;
  };
  guidance: string[];
}

export interface PlaceBetDeps {
  client: PolymarketClient;
  swapRouter: SwapRouter;
  sessionStore: SessionStore;
  x402: X402Verifier;
  charge: X402ChargeRule;
  /** Стейбл USDC для авто-свопа (Polygon по умолчанию). */
  usdcAddress: string;
}

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export async function pmPlaceBet(
  input: PlaceBetToolInput,
  paymentHeader: string | undefined,
  deps: PlaceBetDeps,
): Promise<PlaceBetToolOutput> {
  // 1) Оплата
  const verified = await deps.x402.verify(paymentHeader, deps.charge);
  if (!verified.ok) {
    throw new Error(`x402: ${verified.reason ?? 'оплата не подтверждена'}`);
  }
  // 2) Сессия
  const session = await deps.sessionStore.load(input.sessionId);
  if (!session) throw new Error(`session ${input.sessionId} не найдена — вызови pm_auto_setup`);
  // 3) Swap-quote (опционально)
  let swap: SwapQuote | undefined;
  if (input.auto_swap) {
    swap = await deps.swapRouter.quote({
      chainId: session.chainId,
      fromToken: USDC_POLYGON,
      toToken: deps.usdcAddress,
      amount: input.size,
      userAddress: session.walletAddress,
    });
  }
  // 4) Payload — signatureType/makerMode выбирает клиент по walletKind
  const bet = await deps.client.prepareBet(session.walletAddress, session.walletKind, input);

  const guidance: string[] = [
    `signatureType=${bet.meta.signatureType} · makerMode=${bet.meta.makerMode} — соответствует walletKind=${session.walletKind}.`,
  ];
  if (session.walletKind === 'magic_deposit') {
    guidance.push(
      'CLOB v2: подпишите пейлоад ключом EOA-signer, но maker в payload — адрес depositWallet. Ордер отправляется на POST /orders CLOB API.',
    );
  }
  guidance.push(
    'Оператор шлюза сам отвечает за соблюдение TOS Polymarket и локального законодательства (KYC/AML/geo).',
  );

  return {
    bet,
    ...(swap ? { swap } : {}),
    payment: {
      charged: deps.charge.amount,
      asset: deps.charge.asset,
      network: deps.charge.network,
      paymentId: verified.paymentId ?? 'unknown',
    },
    guidance,
  };
}

export { USDC_POLYGON };
