# Polymarket Ultra Gateway (`polymarket-gateway-core`)

A2MCP (Agent-to-MCP) Skill Provider для взаимодействия автономных ИИ-агентов с Polymarket.

- Совместим со спекой [Model Context Protocol](https://modelcontextprotocol.io/): stdio-транспорт, JSON-Schema инпуты.
- Оплата за вызов по [x402](https://www.x402.org/) (0.10 USDT / генерация payload'а).
- Корректный `signatureType` под архитектуру Polymarket CLOB v2 Deposit Wallet (см. ниже).
- Стабы для OKX DEX / OKX Payment SDK — реальные ключи подставляются через env.

## Инструменты

| Tool | Оплата | Назначение |
|---|---|---|
| `pm_auto_setup` | free | Автопровижининг сессии + чек env. Никакого ручного копипаста ключей. |
| `pm_place_bet` | x402 (0.10 USDT/вызов) | Сборка payload'а ордера с корректным `signatureType` и `makerMode`. Опционально — swap-quote через OKX DEX. |

## `signatureType: 3` — техническое требование, не «обходной путь»

В CLOB v2 Polymarket перешёл на архитектуру «депозитных кошельков» (Magic Wallet / EIP-7702): ордера подписываются от имени смарт-контракта-хранилища через EIP-1271. Из-за этого:

- для `walletKind = magic_deposit` шлюз выставляет **`signatureType: 3`** и **`makerMode: true`**;
- для `eoa` — `signatureType: 0`, `makerMode: false`;
- для `poly_proxy` — `1`; для `poly_gnosis_safe` — `2`.

Если не выставить корректный тип для депозитного кошелька, CLOB возвращает `"Maker address not allowed"` — это не комплаенс-фильтр, а несовместимость архитектур. Комплаенс-проверки Polymarket (KYC, гео-фильтр, TOS, IP-блок) находятся на уровне фронтенда, wallet-connect и IP-адреса.

## Compliance notice

**Оператор шлюза сам отвечает за соблюдение TOS Polymarket и локального законодательства (CFTC, AML, антигэмблинг), в том числе когда действия совершаются автономным ИИ-агентом с его API-ключами. Этот шлюз не подменяет KYC/geo-checks и не предназначен для использования из ограниченных юрисдикций.**

Что этот код **не делает**:
- не ротирует IP-адреса, не поставляет прокси/VPN;
- не подделывает user-agent или заголовки;
- не имитирует KYC.

Если это то, что вам нужно, — этот проект вам не подходит.

## Быстрый старт

```bash
npm install
npm run build
npm test           # Bot-Sanitarian self-check (8 проверок)
npm start          # запуск MCP-сервера через stdio
```

Env:
- `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` — для реальных вызовов OKX DEX Aggregator (пока стаб);
- `CLOB_API_KEY` — для ключа Polymarket CLOB v2;
- `X402_PAY_TO`, `X402_AMOUNT`, `X402_ASSET`, `X402_NETWORK` — параметры оплаты;
- `USDC_ADDRESS` — override адреса USDC (default: Polygon).

## Структура

```
src/
  server.ts                # MCP McpServer + Stdio, registerTool
  tools/
    auto-setup.ts          # pm_auto_setup
    place-bet.ts           # pm_place_bet
  polymarket/
    signatures.ts          # SignatureType + walletKind → sigType/makerMode
    client.ts              # сборка OrderPayload, StubDepositResolver
    swap.ts                # OKX DEX router интерфейс + stub
  payment/
    x402.ts                # X402Verifier интерфейс + stub
  session/
    store.ts               # SessionStore + Memory реализация
  test-runner.ts           # Bot-Sanitarian
polymarket-gateway.json    # ASP-манифест
```

## Bot-Sanitarian

`npm test` гоняет 8 инвариантов:
1. `pm_auto_setup` возвращает `sessionId`.
2. `magic_deposit` → `signatureType=3`, `makerMode=true`.
3. `eoa`/`poly_proxy`/`poly_gnosis_safe` → 0/1/2, `makerMode=false`.
4. Без `X-PAYMENT` — отказ.
5. `auto_swap` возвращает quote со всеми полями.
6. Неизвестный `sessionId` — отказ.

Флагирует брейкинг-чейнджи API до того, как они попадут в реальный prod.

## Лицензия

MIT.
