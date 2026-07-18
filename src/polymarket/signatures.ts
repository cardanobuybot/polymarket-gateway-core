// Типы подписей Polymarket CLOB.
// Ссылка: https://docs.polymarket.com/#signature-types (публичная документация)
//
// 0 = EOA         — обычный внешний адрес, ECDSA-подпись
// 1 = POLY_PROXY  — proxy-кошелёк Polymarket
// 2 = POLY_GNOSIS_SAFE — мультисиг Gnosis Safe
// 3 = MAGIC_DEPOSIT (EIP-1271) — смарт-контракт-подпись депозитного кошелька
//     (актуальная архитектура CLOB v2; ордера подписываются от имени
//     контракта-хранилища, поэтому нужен non-EOA signatureType и makerMode=true,
//     иначе сервер возвращает "Maker address not allowed").
//
// Использование signatureType=3 — это следствие архитектуры аккаунтов, а не
// «магический обход». Комплаенс-фильтры платформы (KYC/geo/AML) находятся на
// уровне фронтенда, IP и wallet-connect, и signature type к ним отношения
// не имеет. Оператор шлюза несёт ответственность за соблюдение TOS.

export const SignatureType = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2,
  MAGIC_DEPOSIT: 3,
} as const;

export type WalletKind = 'eoa' | 'poly_proxy' | 'poly_gnosis_safe' | 'magic_deposit';

export function signatureTypeForWallet(kind: WalletKind): number {
  switch (kind) {
    case 'eoa':
      return SignatureType.EOA;
    case 'poly_proxy':
      return SignatureType.POLY_PROXY;
    case 'poly_gnosis_safe':
      return SignatureType.POLY_GNOSIS_SAFE;
    case 'magic_deposit':
      return SignatureType.MAGIC_DEPOSIT;
  }
}

/**
 * Правило makerMode: для CLOB v2 с депозитным кошельком (magic_deposit) должен быть
 * true, иначе сервер выдаёт "Maker address not allowed" — это техническая
 * несовместимость архитектур, не комплаенс-ошибка.
 */
export function makerModeForWallet(kind: WalletKind): boolean {
  return kind === 'magic_deposit';
}
