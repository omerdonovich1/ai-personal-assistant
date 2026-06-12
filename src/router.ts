import type { ModelTier } from "./llm.js";

// Deterministic, zero-latency message router. Heuristics over an extra LLM
// call: routing must never add latency to simple Telegram I/O, and the
// boundary cases (long analytical Hebrew text, code blocks) are easily
// captured lexically.

const CODE_SIGNALS = [
  /```/,
  /\b(typescript|javascript|python|next\.?js|react|node|api|endpoint|sql|regex|json|npm|git)\b/i,
  /\b(קוד|פונקציה|באג|דיבוג|סקריפט|רפקטור|קומפילציה|שגיאת build)\b/,
  /\bstack ?trace\b/i,
  /\b(error|exception):/i,
];

const ANALYSIS_SIGNALS = [
  /\b(נתח|ניתוח|אסטרטגיה|תכנית עסקית|השווה|השוואה|תמחור|כדאיות|סיכונים|ארכיטקטורה|אפיון)\b/,
  /\b(analy[sz]e|strategy|compare|architecture|tradeoff|pros and cons|roadmap)\b/i,
  /\b(למה|מדוע)\b.{80,}/, // long "why" questions
  /\b(תסביר לעומק|פרט|בהרחבה)\b/,
];

export function routeMessage(text: string): ModelTier {
  if (CODE_SIGNALS.some((re) => re.test(text))) return "code";
  if (ANALYSIS_SIGNALS.some((re) => re.test(text))) return "analysis";
  // Long, multi-part messages are usually analytical even without keywords
  if (text.length > 600) return "analysis";
  return "fast";
}
