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


export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}


export function ftsScore(queryTokens: string[], docTf: Map<string, number>): number {
  const unique = [...new Set(queryTokens)];
  if (unique.length === 0) return 0;
  let score = 0;
  for (const term of unique) {
    const tf = docTf.get(term);
    if (tf) score += 1 + Math.log(tf);
  }
  return score / unique.length;
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
