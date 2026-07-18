// Автоликвидность через OKX DEX API: если на депозитном кошельке нет
// ставочного ассета (обычно USDC на Polygon) — предложить свап-роут.
// Реализация — интерфейс + стаб: реальный вызов OKX DEX Aggregator
// (https://www.okx.com/web3/build/docs/waas/dex-aggregator) подставляется
// оператором через env OKX_API_KEY/SECRET/PASSPHRASE.

export interface SwapQuote {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  routerContract: string;
  calldata: string;
  slippagePct: number;
}

export interface SwapRouter {
  quote(params: {
    chainId: number;
    fromToken: string;
    toToken: string;
    amount: string;
    userAddress: string;
    slippagePct?: number;
  }): Promise<SwapQuote>;
}

/**
 * Стаб: возвращает синтетический quote с указанием, что клиент должен
 * подставить реальные креды OKX DEX API. Не делает сетевых вызовов.
 */
export class OkxDexRouterStub implements SwapRouter {
  async quote(params: {
    chainId: number;
    fromToken: string;
    toToken: string;
    amount: string;
    userAddress: string;
    slippagePct?: number;
  }): Promise<SwapQuote> {
    if (params.fromToken.toLowerCase() === params.toToken.toLowerCase()) {
      throw new Error('fromToken == toToken: swap не нужен');
    }
    return {
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.amount,
      toAmount: params.amount,
      routerContract: '0x0000000000000000000000000000000000000000',
      calldata: '0x',
      slippagePct: params.slippagePct ?? 0.5,
    };
  }
}
