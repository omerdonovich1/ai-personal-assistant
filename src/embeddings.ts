// Voyage AI embeddings (Anthropic's recommended pairing — no native endpoint).
// Thin fetch wrapper, no SDK. Returns null when VOYAGE_API_KEY is unset so the
// memory layer can degrade to keyword search instead of failing.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3";

export function embeddingsAvailable(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

export async function embed(texts: string[]): Promise<number[][] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || texts.length === 0) return null;

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    console.error(`[embeddings] Voyage error ${res.status}: ${await res.text().catch(() => "")}`);
    return null;
  }
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

export async function embedOne(text: string): Promise<number[] | null> {
  const r = await embed([text]);
  return r?.[0] ?? null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
