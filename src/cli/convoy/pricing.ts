interface ModelPricing {
  input: number
  output: number
}

// USD per token (not per 1K/1M)
const PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { input: 15 / 1_000_000,   output: 75 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3 / 1_000_000,    output: 15 / 1_000_000 },
  'claude-haiku-3-5':  { input: 0.80 / 1_000_000, output: 4 / 1_000_000 },
  'gpt-4o':            { input: 2.50 / 1_000_000,  output: 10 / 1_000_000 },
  'gpt-4o-mini':       { input: 0.15 / 1_000_000,  output: 0.60 / 1_000_000 },
  'o3':                { input: 10 / 1_000_000,    output: 40 / 1_000_000 },
  'o3-mini':           { input: 1.10 / 1_000_000,  output: 4.40 / 1_000_000 },
  'o4-mini':           { input: 1.10 / 1_000_000,  output: 4.40 / 1_000_000 },
  'gemini-2.5-pro':    { input: 1.25 / 1_000_000,  output: 10 / 1_000_000 },
  'gemini-2.5-flash':  { input: 0.15 / 1_000_000,  output: 0.60 / 1_000_000 },
  // Adapter fallbacks
  'claude':            { input: 3 / 1_000_000,    output: 15 / 1_000_000 },
  'copilot':           { input: 2.50 / 1_000_000,  output: 10 / 1_000_000 },
  'cursor':            { input: 3 / 1_000_000,    output: 15 / 1_000_000 },
  'opencode':          { input: 3 / 1_000_000,    output: 15 / 1_000_000 },
}

function resolvePricing(model: string): ModelPricing | null {
  const exact = PRICING_TABLE[model]
  if (exact) return exact

  // Prefix match - longest prefix wins
  let best: ModelPricing | null = null
  let bestLen = 0
  for (const key of Object.keys(PRICING_TABLE)) {
    const entry = PRICING_TABLE[key]
    if (entry && model.startsWith(key) && key.length > bestLen) {
      best = entry
      bestLen = key.length
    }
  }
  return best
}

export function hasPricing(model: string | null | undefined): boolean {
  if (model == null) return false
  return resolvePricing(model) !== null
}

export function calculateCost(
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  if (model == null) return null

  const input = promptTokens ?? 0
  const output = completionTokens ?? 0
  if (input === 0 && output === 0) return null

  const pricing = resolvePricing(model)
  if (pricing == null) return null

  return input * pricing.input + output * pricing.output
}
