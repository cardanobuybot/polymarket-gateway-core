// HTTP-транспорт: разворачивает MCP-сервер как публичный HTTPS-endpoint,
// который может вызывать OKX.AI (или любой MCP-клиент). Stateless-режим:
// каждое JSON-RPC сообщение = отдельный запрос, без sticky session.
//
// x402 v2 совместимость (по требованию OKX A2MCP validator):
//   POST /mcp метод `tools/call` с paid-tool → без `X-PAYMENT` заголовка
//   возвращаем HTTP 402 + `PAYMENT-REQUIRED` заголовок с base64-JSON
//   challenge'ом; body тоже JSON для человеческой отладки.
//   Free-методы (initialize, tools/list, notifications, ping) и free-tool
//   `pm_auto_setup` пропускаются без оплаты.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { buildChargeRule } from './payment/x402.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

// USD₮0 на X Layer (mainnet OKX EVM, chainId 196). При смене сети
// (X402_NETWORK / X402_ASSET_ADDRESS) — новые значения из env.
const X402_NETWORK = process.env.X402_NETWORK_EIP155 ?? 'eip155:196';
const X402_ASSET_ADDRESS =
  process.env.X402_ASSET_ADDRESS ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const X402_ASSET_NAME = process.env.X402_ASSET_NAME ?? 'USD₮0';
const X402_ASSET_VERSION = process.env.X402_ASSET_VERSION ?? '1';
const X402_MAX_TIMEOUT_SECONDS = Number(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300');
const X402_DECIMALS = Number(process.env.X402_ASSET_DECIMALS ?? '6');

/** Название tool'ов, требующих оплаты по x402. */
const PAID_TOOLS: ReadonlySet<string> = new Set(['pm_place_bet']);

interface JsonRpcBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function toAtomic(amountHumanReadable: string, decimals: number): string {
  const [intPart, fracPart = ''] = amountHumanReadable.split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${frac}`.replace(/^0+(\d)/, '$1');
  return combined || '0';
}

function buildChallenge(origin: string, description: string, payTo: string, amountAtomic: string) {
  return {
    x402Version: 2,
    resource: {
      url: `${origin}/mcp`,
      description,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: X402_NETWORK,
        asset: X402_ASSET_ADDRESS,
        amount: amountAtomic,
        payTo,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
        extra: { name: X402_ASSET_NAME, version: X402_ASSET_VERSION },
      },
    ],
  };
}

async function json(res: ServerResponse, code: number, body: unknown): Promise<void> {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; parsed: unknown }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return { raw, parsed: undefined };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw, parsed: null };
  }
}

function isPaidCall(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const j = body as JsonRpcBody;
  if (j.method !== 'tools/call') return false;
  const name = j.params?.name;
  return typeof name === 'string' && PAID_TOOLS.has(name);
}

async function main() {
  const { server } = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  await server.connect(transport as never);

  const charge = buildChargeRule(process.env);
  const amountAtomic = toAtomic(charge.amount, X402_DECIMALS);
  const description = `${charge.amount} ${charge.asset} per pm_place_bet call (Polymarket CLOB v2 payload)`;

  const manifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'polymarket-gateway.json',
  );

  const http = createServer(async (req, res) => {
    // Ошибки любого уровня превращаются в JSON — сервер никогда не отдаёт 500.
    try {
      const fwdProto = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim();
      const proto = fwdProto || 'http';
      const hostHeader = req.headers.host ?? 'localhost';
      const origin = `${proto}://${hostHeader}`;
      const url = new URL(req.url ?? '/', origin);

      // CORS (не мешает валидатору OKX и разрешает браузерным клиентам общаться)
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader(
        'access-control-allow-headers',
        'content-type, x-payment, accept',
      );
      res.setHeader('access-control-expose-headers', 'payment-required, x-payment-response');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', service: 'polymarket-gateway-core' });
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/x402') {
        return json(res, 200, buildChallenge(origin, description, charge.payTo, amountAtomic));
      }

      if (req.method === 'GET' && url.pathname === '/manifest') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(await readFile(manifestPath));
        return;
      }

      if (url.pathname === '/mcp') {
        // POST с телом; GET/OTHER → 405-эквивалент через 200+ошибку MCP
        if (req.method !== 'POST') {
          return json(res, 405, { error: 'Use POST for MCP JSON-RPC calls' });
        }
        const { raw, parsed } = await readBody(req);
        if (parsed === null) {
          return json(res, 400, { error: 'Invalid JSON body' });
        }

        const payment = (req.headers['x-payment'] ?? '').toString().trim();

        // x402 challenge: paid tool без валидного X-PAYMENT
        if (isPaidCall(parsed) && !payment) {
          const challenge = buildChallenge(origin, description, charge.payTo, amountAtomic);
          const b64 = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64');
          res.statusCode = 402;
          res.setHeader('payment-required', b64);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(challenge));
          return;
        }

        // Прокинем X-PAYMENT в MCP-tool через inject-в-params.__x402
        // (наш pm_place_bet тул валидирует его через StubX402Verifier).
        let bodyForTransport: unknown = parsed;
        if (payment && parsed && typeof parsed === 'object') {
          const j = parsed as JsonRpcBody;
          if (j.method === 'tools/call' && j.params) {
            const args = j.params.arguments ?? {};
            bodyForTransport = {
              ...j,
              params: {
                ...j.params,
                arguments: { ...args, __x402: payment },
              },
            };
          }
        }

        try {
          await transport.handleRequest(req, res, bodyForTransport);
        } catch (err) {
          if (!res.headersSent) {
            return json(res, 400, {
              error: err instanceof Error ? err.message : String(err),
              raw: raw.slice(0, 200),
            });
          }
        }
        return;
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (e) {
      if (!res.headersSent) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  });

  http.listen(port, host, () => {
    process.stdout.write(
      `polymarket-gateway HTTP: http://${host}:${port} (mcp=/mcp, x402=/.well-known/x402)\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`polymarket-gateway http: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
