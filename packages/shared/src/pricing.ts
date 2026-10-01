/**
 * Official API list prices used to express local CLI usage as an
 * API-equivalent cost. Subscription plans (Claude Max, ChatGPT, …) are not
 * billed per token; this answers "what would this usage cost on the API".
 *
 * Prices are USD per million tokens, verified on {@link PRICING_AS_OF}:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   Cache writes are 1.25× input (5-minute TTL) and 2× input (1-hour TTL);
 *   cache reads differ by model and are listed explicitly.
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 *   Requests with more than 272K input tokens use the long-context row.
 *
 * Models missing here are reported with tokens but no cost.
 *
 * @module shared/pricing
 */

/** Date the table below was last checked against the official pages. */
export const PRICING_AS_OF = '2026-09-30'

export type PricingProvider = 'anthropic' | 'openai'

export interface TokenRates {
  /** Uncached input. */
  input: number
  /** Cache read / cached input. */
  cacheRead: number
  /** Cache write with a 5-minute TTL (OpenAI: the single cache-write rate). */
  cacheWrite5m: number
  /** Cache write with a 1-hour TTL. */
  cacheWrite1h: number
  output: number
}

export interface ModelPrice extends TokenRates {
  provider: PricingProvider
  /** Canonical model id the row was published under. */
  model: string
  /** Rates for requests above {@link longContextThreshold} input tokens. */
  longContext?: TokenRates
  longContextThreshold?: number
}

/** One request's token counts, split the way providers bill them. */
export interface BillableUsage {
  /** Input tokens that were neither read from nor written to a cache. */
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** Output tokens, including reasoning tokens. */
  output: number
}

const OPENAI_LONG_CONTEXT = 272_000

function anthropic(model: string, input: number, output: number, cacheRead: number): ModelPrice {
  return {
    provider: 'anthropic',
    model,
    input,
    output,
    cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  }
}

function openai(
  model: string,
  short: [input: number, cached: number, write: number | undefined, output: number],
  long?: [input: number, cached: number, write: number | undefined, output: number],
): ModelPrice {
  const rates = ([input, cached, write, output]: typeof short): TokenRates => ({
    input,
    cacheRead: cached,
    // OpenAI rows without a published cache-write rate bill writes as input.
    cacheWrite5m: write ?? input,
    cacheWrite1h: write ?? input,
    output,
  })
  return {
    provider: 'openai',
    model,
    ...rates(short),
    ...(long ? { longContext: rates(long), longContextThreshold: OPENAI_LONG_CONTEXT } : {}),
  }
}

const PRICES: readonly ModelPrice[] = [
  // Anthropic
  anthropic('claude-fable-5-1', 10, 50, 0.25),
  anthropic('claude-mythos-5-1', 10, 50, 0.25),
  anthropic('claude-fable-5', 10, 50, 1),
  anthropic('claude-mythos-5', 10, 50, 1),
  anthropic('claude-opus-5-5', 4, 20, 0.2),
  anthropic('claude-opus-5', 5, 25, 0.5),
  anthropic('claude-opus-4-8', 5, 25, 0.5),
  anthropic('claude-opus-4-7', 5, 25, 0.5),
  anthropic('claude-opus-4-6', 5, 25, 0.5),
  anthropic('claude-sonnet-5-5', 2, 10, 0.2),
  anthropic('claude-sonnet-5', 2, 10, 0.2),
  anthropic('claude-sonnet-4-6', 3, 15, 0.3),
  anthropic('claude-haiku-4-5', 1, 5, 0.1),
  // OpenAI
  openai('gpt-6-astra', [10, 1, 12.5, 50], [20, 2, 25, 75]),
  openai('gpt-6.1-sol', [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]),
  openai('gpt-6-sol', [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]),
  openai('gpt-6-luna', [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]),
  openai('gpt-5.6-sol', [4, 0.4, 5, 20], [8, 0.8, 10, 30]),
  openai('gpt-5.6-terra', [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]),
  openai('gpt-5.6-luna', [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]),
  openai('gpt-5.5', [5, 0.5, undefined, 30], [10, 1, undefined, 45]),
  openai('gpt-5.4', [2.5, 0.25, undefined, 15], [5, 0.5, undefined, 22.5]),
  openai('gpt-5.4-mini', [0.75, 0.075, undefined, 4.5]),
  openai('gpt-5.4-nano', [0.2, 0.02, undefined, 1.25]),
  openai('gpt-5.3-codex', [1.75, 0.175, undefined, 14]),
  openai('gpt-5.2', [1.75, 0.175, undefined, 14]),
  openai('gpt-5.1', [1.25, 0.125, undefined, 10]),
  openai('gpt-5', [1.25, 0.125, undefined, 10]),
  openai('gpt-5-mini', [0.25, 0.025, undefined, 2]),
  openai('gpt-5-nano', [0.05, 0.005, undefined, 0.4]),
]

const BY_MODEL = new Map(PRICES.map((price) => [price.model, price]))

/**
 * Finds the published price row for a model id as the CLIs report it.
 *
 * Accepts date-suffixed and 1M-context variants (`claude-sonnet-4-5-20250929`,
 * `claude-opus-4-6[1m]`) and dotted Claude ids; OpenAI ids must match a
 * published id exactly (a `-wm`-style internal suffix is stripped).
 *
 * @param model Model id from a CLI log.
 * @returns The price row, or `undefined` when no official price is known.
 */
export function findModelPrice(model: string | null | undefined): ModelPrice | undefined {
  if (!model) return undefined
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '')
  const exact = BY_MODEL.get(id)
  if (exact) return exact

  if (id.startsWith('claude-')) {
    const normalized = id.replace(/-\d{8}$/, '').replace(/(\d)\.(\d)/g, '$1-$2')
    return BY_MODEL.get(normalized)
  }
  return BY_MODEL.get(id.replace(/-wm$/, ''))
}

/**
 * Prices one request.
 *
 * @param price Row from {@link findModelPrice}.
 * @param usage Token counts for a single API request.
 * @returns Cost in USD.
 */
export function priceRequest(price: ModelPrice, usage: BillableUsage): number {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h
  const rates =
    price.longContext && price.longContextThreshold && promptTokens > price.longContextThreshold
      ? price.longContext
      : price
  return (
    (usage.input * rates.input +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite5m * rates.cacheWrite5m +
      usage.cacheWrite1h * rates.cacheWrite1h +
      usage.output * rates.output) /
    1_000_000
  )
}
