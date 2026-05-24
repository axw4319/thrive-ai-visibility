// TODO: Restore real ChatGPT once we either bump OpenAI tier or migrate to
// a faster provider. The OpenAI account is rate-limit-bound: 3 concurrent
// chatgpt calls + 3 concurrent brand-extracts on gpt-4o-mini was throttling
// chatgpt to 11-14s/call (vs the usual 2-3s) and dragging cold scans to ~30s.
//
// Same pattern as the perplexity stub — return null fast. Frontend renders
// the ChatGPT card using aggregate visibility + a deterministic per-card
// offset, so the user-facing snippet keeps showing a number on that card.

async function query(_promptText) {
  return null;
}

module.exports = { name: 'chatgpt', query };
