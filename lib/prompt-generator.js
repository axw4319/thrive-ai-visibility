const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generatePrompts(profile, brandName, clusters = '') {
  let clusterSection = '';
  if (clusters) {
    clusterSection = `
IMPORTANT — The user has provided these specific keyword clusters that MUST heavily influence the prompts you generate. Build prompts around these topics so the brand would rank for them:
${clusters.split(',').map(c => `- "${c.trim()}"`).join('\n')}

Incorporate these keywords/phrases naturally into the search prompts. These represent the exact services and use cases the brand wants to be found for.
`;
  }

  const prompt = `You are generating search prompts for an AI visibility analysis of "${brandName}".

Company profile:
- Industry: ${profile.industry}
- Services: ${JSON.stringify(profile.services)}
- Location: ${profile.location}
- Target market: ${profile.target_market}
- Description: ${profile.summary}
${clusterSection}
Generate exactly 5 search prompts that someone might type into ChatGPT, Gemini, Perplexity, or Google AI Overviews when looking for companies like "${brandName}". Pick the 5 HIGHEST-VALUE prompts — the ones most likely to be asked by real buyers in this category, covering a mix of discovery ("best / top"), comparison ("alternatives to / vs"), and service-specific queries.

CRITICAL RULES:
1. EVERY prompt MUST naturally produce a LIST of DIRECT competitor companies/brands — companies offering the same core services to the same target market
2. Be hyper-specific to ${profile.industry} and the exact services listed above — generic industry prompts attract unrelated brands
3. Use varied formats: "best X in Y", "top X for Y", "who are the leading X", "recommend X companies", "compare X providers", "what companies offer X", "alternatives to...", "which companies specialize in X"
4. Cover: specific services, target market, location (if applicable), direct comparisons, and niche use cases
5. Make prompts realistic — things real buyers would ask AI when evaluating vendors in this exact space
6. Do NOT mention "${brandName}" in any prompt — these should be generic discovery queries
7. Prompts should be specific enough that AI responses will include ONLY companies that directly compete with "${brandName}" — not adjacent or tangentially related businesses
8. Vary the specificity: some prompts should be broad category queries, others should be narrow niche queries

Categorize each as: service, location, industry, comparison, or recommendation

Return a JSON array of objects: [{"prompt": "...", "category": "..."}]
Return ONLY valid JSON, no markdown.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    const match = res.choices[0].message.content.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse generated prompts');
  }
}

module.exports = { generatePrompts };
