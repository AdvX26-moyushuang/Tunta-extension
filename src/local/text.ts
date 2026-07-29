export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /[a-z0-9]+|[一-鿿㐀-䶿]+/g;
  const lower = text.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lower)) !== null) {
    const term = match[0];
    if (/^[a-z0-9]+$/.test(term)) {
      tokens.push(term);
    } else if (term.length === 1) {
      tokens.push(term);
    } else {
      for (let i = 0; i < term.length - 1; i += 1) {
        tokens.push(term.slice(i, i + 2));
      }
    }
  }
  return tokens;
}


function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface Bm25Hit {
  id: string;
  score: number;
}

/**
 * 标准 BM25（词间 OR 语义），与 SQLite FTS5 的 bm25() 同族。
 * MemoryStore / IdbStore 的 searchCardsFts 退路实现，也是 FTS5 行为的测试基准。
 */
export function bm25Rank(queryTokens: string[], docs: { id: string; tokens: string[] }[]): Bm25Hit[] {
  const unique = [...new Set(queryTokens)];
  if (unique.length === 0 || docs.length === 0) return [];
  const docCount = docs.length;
  const avgLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docCount || 1;
  const tfs = docs.map((doc) => termFrequencies(doc.tokens));
  const dfs = new Map<string, number>();
  for (const term of unique) {
    dfs.set(term, tfs.reduce((n, tf) => n + (tf.has(term) ? 1 : 0), 0));
  }
  const hits: Bm25Hit[] = [];
  docs.forEach((doc, index) => {
    const tf = tfs[index];
    let score = 0;
    for (const term of unique) {
      const freq = tf.get(term);
      if (!freq) continue;
      const df = dfs.get(term) as number;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      score += (idf * freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + (BM25_B * doc.tokens.length) / avgLen));
    }
    if (score > 0) hits.push({ id: doc.id, score });
  });
  return hits.sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
