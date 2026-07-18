// Тонкая обёртка над CLOB v2 API Polymarket. Реализация — заглушки под
// официальные эндпоинты (https://docs.polymarket.com/) с чистым интерфейсом,
// чтобы легко подменить на реальную клиентскую библиотеку, когда она нужна.

import type { WalletKind } from './signatures.js';
import { makerModeForWallet, signatureTypeForWallet } from './signatures.js';

export interface PlaceBetInput {
  sessionId: string;
  marketId: string;
  outcomeId: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
}

export interface OrderPayload {
  /** Кто размещает ордер (deposit-wallet, а не EOA-signer при magic_deposit). */
  maker: string;
  /** EOA, который подписал ордер (совпадает с maker для EOA/PROXY/GNOSIS). */
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 'BUY' | 'SELL';
  expiration: number;
  nonce: string;
  feeRateBps: number;
  signatureType: number;
  makerMode: boolean;
  /** Заглушка подписи — фактический подписант вычисляется у оператора. */
  signature: string;
}

export interface PreparedBet {
  /** Готовый payload для POST /orders. */
  payload: OrderPayload;
  /** Метаданные для логов и проверок. */
  meta: {
    walletKind: WalletKind;
    signatureType: number;
    makerMode: boolean;
    expectedBlockingErrorIfWrong?: string;
  };
}

const ONE_HOUR = 3600;

export interface DepositAddressesResolver {
  /** Возвращает deposit-wallet-адрес по EOA-signer'у. Для magic_deposit —
   *  адрес proxy-контракта Polymarket. Для EOA — тот же EOA. */
  resolveDeposit(eoa: string, kind: WalletKind): Promise<string>;
}

export class PolymarketClient {
  constructor(private readonly resolver: DepositAddressesResolver) {}

  async prepareBet(
    signerEoa: string,
    walletKind: WalletKind,
    input: PlaceBetInput,
  ): Promise<PreparedBet> {
    const deposit = await this.resolver.resolveDeposit(signerEoa, walletKind);
    const sigType = signatureTypeForWallet(walletKind);
    const makerMode = makerModeForWallet(walletKind);
    const priceNumerator = Number(input.price);
    if (!Number.isFinite(priceNumerator) || priceNumerator <= 0 || priceNumerator >= 1) {
      throw new Error(`price должен быть в открытом интервале (0, 1); получено: ${input.price}`);
    }
    const sizeUnits = Number(input.size);
    if (!Number.isFinite(sizeUnits) || sizeUnits <= 0) {
      throw new Error(`size должен быть > 0; получено: ${input.size}`);
    }
    const makerAmount =
      input.side === 'BUY'
        ? toUsdc6(sizeUnits * priceNumerator)
        : toShares6(sizeUnits);
    const takerAmount =
      input.side === 'BUY'
        ? toShares6(sizeUnits)
        : toUsdc6(sizeUnits * priceNumerator);
    const payload: OrderPayload = {
      maker: deposit,
      signer: signerEoa,
      tokenId: input.outcomeId,
      makerAmount,
      takerAmount,
      side: input.side,
      expiration: Math.floor(Date.now() / 1000) + ONE_HOUR,
      nonce: `${Date.now()}-${cryptoRandom()}`,
      feeRateBps: 0,
      signatureType: sigType,
      makerMode,
      signature: '0x',
    };
    const meta: PreparedBet['meta'] = { walletKind, signatureType: sigType, makerMode };
    if (walletKind === 'magic_deposit') {
      meta.expectedBlockingErrorIfWrong =
        'Maker address not allowed (при signatureType!=3 или makerMode=false)';
    }
    return { payload, meta };
  }
}

function toUsdc6(v: number): string {
  return Math.round(v * 1e6).toString();
}
function toShares6(v: number): string {
  return Math.round(v * 1e6).toString();
}

function cryptoRandom(): string {
  const buf = new Uint8Array(8);
  // Node 20+ имеет глобальный crypto с getRandomValues.
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Простой resolver-стаб: при интеграции с реальным контрактом deposit-wallet
 * этот метод должен считать proxy-адрес CREATE2 по формуле Polymarket.
 * Сейчас — детерминистический хеш для теста без сети.
 */
export class StubDepositResolver implements DepositAddressesResolver {
  async resolveDeposit(eoa: string, kind: WalletKind): Promise<string> {
    if (kind === 'eoa') return eoa;
    // XOR последних 4 байт с меткой типа, чтобы отличать от EOA.
    const buf = eoa.toLowerCase().replace(/^0x/, '');
    const tag = ({ poly_proxy: 0x01, poly_gnosis_safe: 0x02, magic_deposit: 0x03 } as const)[kind];
    const head = buf.slice(0, -2);
    const last = parseInt(buf.slice(-2), 16) ^ tag;
    return `0x${head}${last.toString(16).padStart(2, '0')}`;
  }
}
