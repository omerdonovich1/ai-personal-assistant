// Long-term contextual memory across the 5 domains.
//
// Storage: `memories` table (Postgres) with embeddings stored as jsonb and
// cosine ranking computed in Node. At personal scale (<10k memories) this is
// faster and far more portable than managing a pgvector extension; swap to
// pgvector later only if volume demands it.
//
// Degradation ladder:
//   Postgres + Voyage key  → semantic recall (embeddings)
//   Postgres, no key       → keyword recall (ILIKE)
//   no Postgres            → in-process array (session-lifetime only)

import { db, ensureSchema } from "./db.js";
import { embedOne, cosine, embeddingsAvailable } from "./embeddings.js";

export interface Memory {
  id: number;
  domain: string | null; // null = global
  type: string;          // decision | spec | preference | note | fact
  content: string;
  createdAt: string;
}

interface MemRow extends Memory { embedding: number[] | null }

// JSON-mode fallback (no persistence guarantees — Postgres is the real path)
const ephemeral: MemRow[] = [];
let ephemeralId = 1;

export async function rememberContext(
  content: string,
  domain: string | null = null,
  type = "note"
): Promise<{ id: number }> {
  const vec = await embedOne(content).catch(() => null);
  if (db) {
    await ensureSchema();
    const r = await db.query(
      "INSERT INTO memories (domain, type, content, embedding) VALUES ($1, $2, $3, $4) RETURNING id",
      [domain, type, content, vec ? JSON.stringify(vec) : null]
    );
    return { id: r.rows[0].id };
  }
  ephemeral.push({ id: ephemeralId++, domain, type, content, createdAt: new Date().toISOString(), embedding: vec });
  return { id: ephemeralId - 1 };
}

async function allMemories(domain: string | null): Promise<MemRow[]> {
  if (db) {
    await ensureSchema();
    const r = domain
      ? await db.query("SELECT id, domain, type, content, embedding, created_at FROM memories WHERE domain = $1 OR domain IS NULL", [domain])
      : await db.query("SELECT id, domain, type, content, embedding, created_at FROM memories");
    return r.rows.map((x) => ({
      id: x.id, domain: x.domain, type: x.type, content: x.content,
      createdAt: x.created_at, embedding: x.embedding as number[] | null,
    }));
  }
  return domain ? ephemeral.filter((m) => m.domain === domain || m.domain === null) : ephemeral;
}

export async function recallContext(
  query: string,
  domain: string | null = null,
  k = 5
): Promise<Memory[]> {
  const candidates = await allMemories(domain);
  if (candidates.length === 0) return [];

  if (embeddingsAvailable()) {
    const qVec = await embedOne(query).catch(() => null);
    if (qVec) {
      const withVec = candidates.filter((m) => m.embedding);
      const scored = withVec
        .map((m) => ({ m, score: cosine(qVec, m.embedding!) }))
        .sort((a, b) => b.score - a.score)
        .filter((s) => s.score > 0.3)
        .slice(0, k);
      if (scored.length > 0) return scored.map((s) => stripVec(s.m));
    }
  }

  // Keyword fallback: rank by shared word count
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = candidates
    .map((m) => ({
      m,
      score: words.filter((w) => m.content.toLowerCase().includes(w)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map((s) => stripVec(s.m));
}

export async function countMemories(): Promise<number> {
  if (db) {
    await ensureSchema();
    const r = await db.query("SELECT count(*)::int AS n FROM memories");
    return r.rows[0].n as number;
  }
  return ephemeral.length;
}

function stripVec(m: MemRow): Memory {
  const { embedding: _e, ...rest } = m;
  return rest;
}

/** One-time seed: import legacy user-memory facts into vector memory. */
export async function seedFromFacts(facts: Array<{ key: string; value: string; context: string | null }>): Promise<number> {
  if ((await countMemories()) > 0) return 0; // already seeded
  let n = 0;
  for (const f of facts) {
    await rememberContext(`${f.key}: ${f.value}`, f.context, "fact");
    n++;
  }
  return n;
}
