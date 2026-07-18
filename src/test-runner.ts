// «Bot-Sanitarian»: локальный self-check, гоняется по расписанию
// (напр., systemd timer/cron) и валидирует что:
//   1) pm_auto_setup возвращает sessionId
//   2) pm_place_bet собирает payload с signatureType, соответствующим walletKind
//   3) для magic_deposit signatureType строго 3 и makerMode=true
//   4) x402 отклоняет вызов без валидного заголовка
//   5) auto_swap отдаёт swap-quote с корректными полями
//
// Выход: exit 0 при успехе, exit 1 при любом провале + строка ERR в stderr.

import { buildServer } from './server.js';
import { pmAutoSetup } from './tools/auto-setup.js';
import { pmPlaceBet, USDC_POLYGON } from './tools/place-bet.js';
import { SignatureType } from './polymarket/signatures.js';
import type { WalletKind } from './polymarket/signatures.js';

interface Check {
  name: string;
  run: () => Promise<void>;
}

const TEST_EOA = '0x' + 'ab'.repeat(20);

async function runChecks(checks: Check[]): Promise<{ pass: number; fail: number }> {
  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    try {
      await c.run();
      process.stdout.write(`✓ ${c.name}\n`);
      pass++;
    } catch (e) {
      process.stderr.write(`✗ ${c.name}\nERR: ${e instanceof Error ? e.message : String(e)}\n`);
      fail++;
    }
  }
  return { pass, fail };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const parts = buildServer(process.env);

  const checks: Check[] = [
    {
      name: 'pm_auto_setup(magic_deposit) отдаёт sessionId и env-снапшот',
      run: async () => {
        const out = await pmAutoSetup(
          { walletAddress: TEST_EOA, walletKind: 'magic_deposit' },
          parts.sessionStore,
          process.env,
        );
        assert(out.sessionId.length >= 16, 'sessionId слишком короткий');
        assert(out.walletKind === 'magic_deposit', 'walletKind не сохранился');
        assert(
          out.supportedWalletKinds.includes('magic_deposit'),
          'magic_deposit не в списке поддерживаемых',
        );
      },
    },
    {
      name: 'pm_place_bet: magic_deposit → signatureType=3, makerMode=true',
      run: async () => {
        const setup = await pmAutoSetup(
          { walletAddress: TEST_EOA, walletKind: 'magic_deposit' },
          parts.sessionStore,
          process.env,
        );
        const out = await pmPlaceBet(
          {
            sessionId: setup.sessionId,
            marketId: 'market-xyz',
            outcomeId: 'yes-token-1',
            side: 'BUY',
            price: '0.42',
            size: '10',
          },
          'x402:test-payment-id:0.10',
          {
            client: parts.client,
            swapRouter: parts.swapRouter,
            sessionStore: parts.sessionStore,
            x402: parts.x402,
            charge: parts.charge,
            usdcAddress: USDC_POLYGON,
          },
        );
        assert(
          out.bet.payload.signatureType === SignatureType.MAGIC_DEPOSIT,
          `signatureType ожидался 3, получено ${out.bet.payload.signatureType}`,
        );
        assert(out.bet.payload.makerMode === true, 'makerMode должен быть true для magic_deposit');
        assert(out.bet.meta.walletKind === 'magic_deposit', 'meta.walletKind не совпадает');
        assert(out.payment.charged === parts.charge.amount, 'charged != rule.amount');
      },
    },
    ...(['eoa', 'poly_proxy', 'poly_gnosis_safe'] as WalletKind[]).map<Check>((kind) => ({
      name: `pm_place_bet: ${kind} → signatureType соответствует и makerMode=false`,
      run: async () => {
        const setup = await pmAutoSetup(
          { walletAddress: TEST_EOA, walletKind: kind },
          parts.sessionStore,
          process.env,
        );
        const out = await pmPlaceBet(
          {
            sessionId: setup.sessionId,
            marketId: 'm',
            outcomeId: 'o',
            side: 'SELL',
            price: '0.5',
            size: '1',
          },
          'x402:pay-01234:0.10',
          {
            client: parts.client,
            swapRouter: parts.swapRouter,
            sessionStore: parts.sessionStore,
            x402: parts.x402,
            charge: parts.charge,
            usdcAddress: USDC_POLYGON,
          },
        );
        const expected =
          kind === 'eoa'
            ? SignatureType.EOA
            : kind === 'poly_proxy'
              ? SignatureType.POLY_PROXY
              : SignatureType.POLY_GNOSIS_SAFE;
        assert(
          out.bet.payload.signatureType === expected,
          `${kind}: ожидался signatureType=${expected}, получено ${out.bet.payload.signatureType}`,
        );
        assert(out.bet.payload.makerMode === false, `${kind}: makerMode должен быть false`);
      },
    })),
    {
      name: 'pm_place_bet отклоняет вызов без x402-заголовка',
      run: async () => {
        const setup = await pmAutoSetup(
          { walletAddress: TEST_EOA, walletKind: 'magic_deposit' },
          parts.sessionStore,
          process.env,
        );
        let threw = false;
        try {
          await pmPlaceBet(
            {
              sessionId: setup.sessionId,
              marketId: 'm',
              outcomeId: 'o',
              side: 'BUY',
              price: '0.5',
              size: '1',
            },
            undefined,
            {
              client: parts.client,
              swapRouter: parts.swapRouter,
              sessionStore: parts.sessionStore,
              x402: parts.x402,
              charge: parts.charge,
              usdcAddress: USDC_POLYGON,
            },
          );
        } catch (e) {
          threw = true;
          assert(String(e).includes('x402'), 'ошибка должна упоминать x402');
        }
        assert(threw, 'вызов без оплаты должен был бросить исключение');
      },
    },
    {
      name: 'auto_swap возвращает quote со всеми обязательными полями',
      run: async () => {
        const setup = await pmAutoSetup(
          { walletAddress: TEST_EOA, walletKind: 'magic_deposit' },
          parts.sessionStore,
          process.env,
        );
        const out = await pmPlaceBet(
          {
            sessionId: setup.sessionId,
            marketId: 'm',
            outcomeId: 'o',
            side: 'BUY',
            price: '0.5',
            size: '5',
            auto_swap: true,
          },
          'x402:pay-01234:0.10',
          {
            client: parts.client,
            swapRouter: parts.swapRouter,
            sessionStore: parts.sessionStore,
            x402: parts.x402,
            charge: parts.charge,
            // Разный from/to, чтобы стаб не выбросил "swap не нужен"
            usdcAddress: '0x0000000000000000000000000000000000000001',
          },
        );
        assert(out.swap, 'swap должен присутствовать при auto_swap=true');
        assert(out.swap.fromAmount === '5', 'swap.fromAmount не совпадает с size');
        assert(out.swap.routerContract.length === 42, 'routerContract должен быть адресом');
      },
    },
    {
      name: 'session с неизвестным id → отказ (защита от несанкционированного вызова)',
      run: async () => {
        let threw = false;
        try {
          await pmPlaceBet(
            {
              sessionId: 'unknown-session',
              marketId: 'm',
              outcomeId: 'o',
              side: 'BUY',
              price: '0.5',
              size: '1',
            },
            'x402:pay-01234:0.10',
            {
              client: parts.client,
              swapRouter: parts.swapRouter,
              sessionStore: parts.sessionStore,
              x402: parts.x402,
              charge: parts.charge,
              usdcAddress: USDC_POLYGON,
            },
          );
        } catch (e) {
          threw = true;
          assert(String(e).includes('session'), 'ошибка должна упоминать session');
        }
        assert(threw, 'неизвестная session должна была бросить исключение');
      },
    },
  ];

  const { pass, fail } = await runChecks(checks);
  process.stdout.write(`\nBot-Sanitarian: ${pass} pass, ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`test-runner fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
