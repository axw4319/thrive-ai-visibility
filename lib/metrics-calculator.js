const db = require('../database');

function calculateMetrics(scanId) {
  const mentions = db.getMentions.all(scanId);
  const prompts = db.getPrompts.all(scanId);
  const totalPrompts = prompts.length;
  const models = [...new Set(mentions.map(m => m.model_name))];

  if (mentions.length === 0 || totalPrompts === 0) return [];

  // Group mentions by normalized brand name
  const brandMap = {};
  for (const m of mentions) {
    const key = m.normalized_name;
    if (!brandMap[key]) {
      brandMap[key] = {
        brand_name: m.brand_name,
        normalized_name: key,
        mentions: [],
        promptsSeen: new Set(),
        modelsSeen: {}
      };
    }
    brandMap[key].mentions.push(m);
    brandMap[key].promptsSeen.add(m.prompt_text);
    if (!brandMap[key].modelsSeen[m.model_name]) brandMap[key].modelsSeen[m.model_name] = 0;
    brandMap[key].modelsSeen[m.model_name]++;
    // Keep the most common display name
    if (m.brand_name.length > brandMap[key].brand_name.length) {
      brandMap[key].brand_name = m.brand_name;
    }
  }

  const totalMentions = mentions.length;
  const results = [];

  for (const [key, data] of Object.entries(brandMap)) {
    const mentionCount = data.mentions.length;
    const promptsAppeared = data.promptsSeen.size;
    const avgRank = data.mentions.reduce((s, m) => s + (m.position || 0), 0) / mentionCount;
    const avgSentiment = data.mentions.reduce((s, m) => s + (m.sentiment_score || 0), 0) / mentionCount;

    // Visibility: % of total prompt-model combinations where brand appeared
    const totalCombinations = totalPrompts * models.length;
    const visibilityPct = totalCombinations > 0 ? (mentionCount / totalCombinations) * 100 : 0;

    // Market share: brand's mentions as % of total mentions
    const marketSharePct = totalMentions > 0 ? (mentionCount / totalMentions) * 100 : 0;

    results.push({
      scan_id: scanId,
      brand_name: data.brand_name,
      normalized_name: key,
      visibility_pct: Math.round(visibilityPct * 10) / 10,
      market_share_pct: Math.round(marketSharePct * 10) / 10,
      avg_rank: Math.round(avgRank * 10) / 10,
      mention_count: mentionCount,
      avg_sentiment: Math.round(avgSentiment * 100) / 100
    });
  }

  // Sort by visibility descending
  results.sort((a, b) => b.visibility_pct - a.visibility_pct);

  // Clear old metrics and save new ones
  db.clearMetrics.run(scanId);
  for (const r of results) {
    db.insertMetric.run(r.scan_id, r.brand_name, r.normalized_name, r.visibility_pct, r.market_share_pct, r.avg_rank, r.mention_count, r.avg_sentiment);
  }

  return results;
}

module.exports = { calculateMetrics };
