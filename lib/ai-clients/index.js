const openaiClient = require('./openai');
const geminiClient = require('./gemini');
const serpOverviewsClient = require('./serpapi-overviews');
const perplexityClient = require('./perplexity');

// Full tier: all 4 engines run in parallel per prompt. Parallelized across prompts,
// so total latency is bounded by the slowest single prompt (~8–12s).
// Override via AI_MODELS env var, e.g. AI_MODELS="chatgpt,gemini" for lighter runs.
const ALL_CLIENTS = {
  chatgpt: openaiClient,
  gemini: geminiClient,
  perplexity: perplexityClient,
  google_ai_overview: serpOverviewsClient,
};

const enabledNames = (process.env.AI_MODELS || 'chatgpt,gemini,perplexity,google_ai_overview')
  .split(',').map(s => s.trim()).filter(Boolean);
const clients = enabledNames.map(n => ALL_CLIENTS[n]).filter(Boolean);

console.log(`[AI] Enabled models: ${clients.map(c => c.name).join(', ')}`);

async function queryAll(promptText) {
  const results = await Promise.allSettled(
    clients.map(client =>
      client.query(promptText).then(
        response => ({ model_name: client.name, response }),
        err => {
          console.error(`  [${client.name}] Error: ${err.message}`);
          return { model_name: client.name, response: null, error: err.message };
        }
      )
    )
  );
  return results.map(r => r.value);
}

function getModelNames() {
  return clients.map(c => c.name);
}

module.exports = { queryAll, getModelNames, clients };
