// x402 pay-per-call: клиент оплачивает вызов, сервер верифицирует пейменты
// по HTTP-заголовку `X-PAYMENT`. Стаб-верификатор — под замену на
// OKX Payment SDK или совместимый facilitator (например, x402.org/facilitator).
// Спека: https://www.x402.org/

export interface X402ChargeRule {
  amount: string;
  asset: string;
  network: string;
  /** Куда получатель (адрес шлюза) хочет получать оплату. */
  payTo: string;
}

export interface X402Verification {
  ok: boolean;
  reason?: string;
  paymentId?: string;
}

export interface X402Verifier {
  verify(header: string | undefined, rule: X402ChargeRule): Promise<X402Verification>;
}

/**
 * Стаб: принимает любую строку формата `x402:<paymentId>:<amount>` при
 * условии, что amount не меньше требуемого. Реальная реализация делает
 * HTTPS-запрос на facilitator и проверяет подпись.
 */
export class StubX402Verifier implements X402Verifier {
  async verify(header: string | undefined, rule: X402ChargeRule): Promise<X402Verification> {
    if (!header) return { ok: false, reason: 'Отсутствует заголовок X-PAYMENT' };
    const m = /^x402:([a-z0-9-]{8,}):(\d+(?:\.\d+)?)$/i.exec(header.trim());
    if (!m) return { ok: false, reason: 'Некорректный формат X-PAYMENT' };
    const paidStr = m[2];
    if (!paidStr) return { ok: false, reason: 'Отсутствует сумма' };
    const paid = Number(paidStr);
    const required = Number(rule.amount);
    if (!Number.isFinite(paid) || paid < required) {
      return { ok: false, reason: `Недостаточная оплата: ${paid} < ${required} ${rule.asset}` };
    }
    return m[1] ? { ok: true, paymentId: m[1] } : { ok: true };
  }
}

export function buildChargeRule(env: NodeJS.ProcessEnv): X402ChargeRule {
  return {
    amount: env.X402_AMOUNT ?? '0.10',
    asset: env.X402_ASSET ?? 'USDT',
    network: env.X402_NETWORK ?? 'polygon',
    payTo: env.X402_PAY_TO ?? '0x0000000000000000000000000000000000000000',
  };
}
