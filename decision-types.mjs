export function validateQuestion(q) {
  if (!q || typeof q.instructions !== 'string' || !q.instructions.trim()) throw new Error('Question instructions required');
  if (q.type === 'score') {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || q.criteria.some(x => typeof x !== 'string')) throw new Error('Invalid Score criteria');
  } else if (q.type === 'choice') {
    if (!q.criteria || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 1 || Object.keys(q.criteria).length > 255 || Object.values(q.criteria).some(x => typeof x !== 'string')) throw new Error('Invalid Choice options');
  } else if (q.type !== 'noul') throw new Error('Unsupported primitive');
}
const unit = x => Number.isFinite(x) && x >= 0 && x <= 1;
export function normalizeAnswer(a, q, {legacy = false} = {}) {
  validateQuestion(legacy && !q.instructions ? {...q,instructions:'Legacy Score request'} : q);
  if (!a || a.type !== q.type) throw new Error('Answer type mismatch');
  if (q.type === 'noul') {
    if (!unit(a.noul)) throw new Error('Invalid Noul');
    return {type: 'noul', noul: a.noul};
  }
  if (!unit(a.confidence)) throw new Error('Invalid confidence');
  if (q.type === 'choice' && !Object.hasOwn(q.criteria, a.choice)) throw new Error('Unsupported choice ID');
  if (q.type === 'score' && (!Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)) throw new Error('Invalid Score');
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const p = a.probabilities;
  if (!(legacy && q.type === 'score' && p === undefined)) {
    if (!p || typeof p !== 'object' || Object.keys(p).length !== keys.length || !keys.every(k => Object.hasOwn(p, k) && unit(p[k])) || Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) > 0.025) throw new Error('Invalid probability distribution');
  }
  return {type: q.type, ...(q.type === 'score' ? {score: a.score} : {choice: a.choice}), confidence: a.confidence, ...(p ? {probabilities: {...p}} : {})};
}
export function normalizeResponse(data, request, options) {
  if (data?.model !== request.model) throw new Error('Responding model differs from pinned model');
  if (!data.answers || Object.keys(data.answers).length !== Object.keys(request.questions).length) throw new Error('Missing or additional answers');
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  return {model: data.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, normalizeAnswer(data.answers[id], q, options)])), usage: {input_tokens: count(data.usage?.input_tokens), output_tokens: count(data.usage?.output_tokens)}};
}
