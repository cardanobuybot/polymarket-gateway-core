// MCP-сервер по спеке Anthropic: stdio-транспорт, два зарегистрированных
// инструмента pm_auto_setup (бесплатный) и pm_place_bet (x402 pay-per-call).
// Комплаенс-нейтральный технический слой: signatureType выбирается по
// walletKind сессии (см. src/polymarket/signatures.ts).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pmAutoSetup } from './tools/auto-setup.js';
import { pmPlaceBet, USDC_POLYGON } from './tools/place-bet.js';
import { PolymarketClient, StubDepositResolver } from './polymarket/client.js';
import { OkxDexRouterStub } from './polymarket/swap.js';
import { buildChargeRule, StubX402Verifier } from './payment/x402.js';
import { MemorySessionStore } from './session/store.js';

const WALLET_KIND = z.enum(['eoa', 'poly_proxy', 'poly_gnosis_safe', 'magic_deposit']);
const HEX_ADDR = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'walletAddress должен быть 0x + 40 hex');
const PRICE = z.string().regex(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/, 'price должен быть в [0,1]');
const SIZE = z.string().regex(/^\d+(\.\d{1,6})?$/, 'size — положительное число');

export function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const sessionStore = new MemorySessionStore();
  const client = new PolymarketClient(new StubDepositResolver());
  const swapRouter = new OkxDexRouterStub();
  const x402 = new StubX402Verifier();
  const charge = buildChargeRule(env);

  const server = new McpServer(
    {
      name: 'polymarket-gateway-core',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  server.registerTool(
    'pm_auto_setup',
    {
      title: 'Автосетап сессии Polymarket',
      description:
        'Провизионирует sessionId, читает env-конфиг и возвращает состояние окружения. Бесплатный шаг перед pm_place_bet.',
      inputSchema: {
        walletAddress: HEX_ADDR,
        walletKind: WALLET_KIND,
        chainId: z.literal(137).optional(),
      },
    },
    async (input) => {
      const out = await pmAutoSetup(
        {
          walletAddress: input.walletAddress,
          walletKind: input.walletKind,
          ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
        },
        sessionStore,
        env,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'pm_place_bet',
    {
      title: 'Подготовить ставочный payload',
      description:
        'Собирает ордер CLOB v2 с корректным signatureType и makerMode для типа кошелька сессии. x402: 0.10 USDT/вызов. Оператор сам отвечает за соблюдение TOS/KYC/geo.',
      inputSchema: {
        sessionId: z.string().min(8),
        marketId: z.string().min(1),
        outcomeId: z.string().min(1),
        side: z.enum(['BUY', 'SELL']),
        price: PRICE,
        size: SIZE,
        auto_swap: z.boolean().optional(),
        /** MCP-клиент передаёт заголовок оплаты в этом поле (эмулируем x402-header). */
        __x402: z.string().optional(),
      },
    },
    async (input) => {
      const out = await pmPlaceBet(
        {
          sessionId: input.sessionId,
          marketId: input.marketId,
          outcomeId: input.outcomeId,
          side: input.side,
          price: input.price,
          size: input.size,
          ...(input.auto_swap !== undefined ? { auto_swap: input.auto_swap } : {}),
        },
        input.__x402,
        {
          client,
          swapRouter,
          sessionStore,
          x402,
          charge,
          usdcAddress: env.USDC_ADDRESS ?? USDC_POLYGON,
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  return { server, sessionStore, client, swapRouter, x402, charge };
}

async function main() {
  const { server } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Запускаем main() только когда это точка входа, а не импорт из теста.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.js') ||
  process.argv[1]?.endsWith('server.ts');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`polymarket-gateway-core: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
