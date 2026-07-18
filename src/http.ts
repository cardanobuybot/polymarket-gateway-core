// HTTP-транспорт: разворачивает MCP-сервер как публичный HTTPS-endpoint,
// который может вызывать OKX.AI (или любой MCP-клиент). Stateless-режим:
// каждое JSON-RPC сообщение = отдельный запрос, без sticky session.
//
// Также предоставляет:
//   - GET /health — для health-check Railway.
//   - GET /.well-known/x402 — публикация ставки оплаты по спеке x402.
//   - GET /manifest — отдаёт polymarket-gateway.json.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { buildChargeRule } from './payment/x402.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

async function json(res: ServerResponse, code: number, body: unknown): Promise<void> {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function main() {
  const { server } = buildServer();
  // Stateless: недоступен sticky session — каждое JSON-RPC сообщение
  // отдельным запросом. TS-типы MCP SDK строги; каст точечный.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  await server.connect(transport as never);

  const charge = buildChargeRule(process.env);

  const manifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'polymarket-gateway.json',
  );

  const http = createServer(async (req, res) => {
    try {
      // Railway (и любой TLS-терминатор) передаёт scheme в x-forwarded-proto.
      const fwdProto = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]?.trim();
      const proto = fwdProto || 'http';
      const host = req.headers.host ?? 'localhost';
      const origin = `${proto}://${host}`;
      const url = new URL(req.url ?? '/', origin);

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', service: 'polymarket-gateway-core' });
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/x402') {
        return json(res, 200, {
          version: 1,
          services: [
            {
              scheme: 'exact',
              network: charge.network,
              asset: charge.asset,
              amount: charge.amount,
              payTo: charge.payTo,
              endpoint: `${origin}/mcp`,
              description: '0.10 USDT per pm_place_bet call (Polymarket CLOB v2 payload)',
            },
          ],
        });
      }

      if (req.method === 'GET' && url.pathname === '/manifest') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(await readFile(manifestPath));
        return;
      }

      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

      return json(res, 404, { error: 'Not Found' });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
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
