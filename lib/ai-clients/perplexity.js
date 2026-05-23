// TODO: Restore real Perplexity API once billing/quota is replenished
// (https://www.perplexity.ai/settings/api). Until then, the Perplexity card
// is a UI-only placeholder — the score it displays comes from the aggregate
// target visibility + a deterministic per-card offset on the frontend.
//
// Earlier we proxied this through GPT-4o-mini to fill the snippet with real
// mentions, but that added 3 concurrent OpenAI calls per scan on top of the
// 3 chatgpt calls and 3 brand-extraction calls — pushing the account into
// rate-limit slowdown (calls taking 10-12s instead of 2-3s). Returning null
// here cuts ~9 calls/scan down to ~6 and unsticks the OpenAI throttle.

async function query(_promptText) {
  return null;
}

module.exports = { name: 'perplexity', query };
