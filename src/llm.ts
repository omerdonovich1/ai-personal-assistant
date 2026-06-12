// Model tier abstraction — single place that maps work-type to model.
// fast:     Telegram I/O, categorization, calendar/tasks CRUD (default)
// analysis: business analysis, planning, comparisons, long-form reasoning
// code:     code generation, debugging, architecture deep-dives

export type ModelTier = "fast" | "analysis" | "code";

const MODELS: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5",
  analysis: "claude-sonnet-4-6",
  code: "claude-opus-4-8",
};

const MAX_TOKENS: Record<ModelTier, number> = {
  fast: 2048,
  analysis: 4096,
  code: 8192,
};

export function modelFor(tier: ModelTier): { model: string; maxTokens: number } {
  return { model: MODELS[tier], maxTokens: MAX_TOKENS[tier] };
}
