// Fuzzy prompt matching for cache lookups
// Normalizes prompts into keyword sets, then checks Jaccard similarity

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','can','shall',
  'that','this','these','those','it','its','what','which','who','whom','how',
  'when','where','why','if','then','than','so','no','not','only','very',
  'just','about','also','some','any','all','each','every','both','few',
  'more','most','other','into','over','after','before','between','under',
  'again','further','once','here','there','i','me','my','we','our','you','your'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Find the best matching cached prompt for a given prompt text
// Returns the cached row if similarity >= threshold, else null
function findFuzzyMatch(promptText, db, threshold = 0.7) {
  // Get all cached prompts from last 7 days
  const allCached = db.prepare(
    `SELECT DISTINCT prompt_text FROM response_cache WHERE created_at > datetime('now', '-7 days')`
  ).all();

  if (allCached.length === 0) return null;

  const inputTokens = tokenize(promptText);
  if (inputTokens.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const row of allCached) {
    // Skip exact matches (those are handled by the normal cache)
    if (row.prompt_text === promptText) continue;

    const cachedTokens = tokenize(row.prompt_text);
    const score = jaccardSimilarity(inputTokens, cachedTokens);

    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestMatch = row.prompt_text;
    }
  }

  return bestMatch;
}

module.exports = { findFuzzyMatch, jaccardSimilarity, tokenize };
