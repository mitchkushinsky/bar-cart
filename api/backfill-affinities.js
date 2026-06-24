/* global process */
import { createClient } from '@supabase/supabase-js'

function extractJSONArray(text) {
  const t = text.trim()
  try { const v = JSON.parse(t); if (Array.isArray(v)) return v } catch { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) try { const v = JSON.parse(fenced[1]); if (Array.isArray(v)) return v } catch { /* fall through */ }
  const arr = t.match(/\[[\s\S]*\]/)
  if (arr) try { return JSON.parse(arr[0]) } catch { /* fall through */ }
  throw new Error('Could not parse JSON array from Claude response')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { ingredients } = req.body || {}
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients array required' })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[backfill-affinities] missing Supabase service-role config')
    return res.status(500).json({ error: 'Missing Supabase service-role config — set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL in env vars' })
  }

  const ingredientList = ingredients
    .map((ing, i) => {
      let line = `${i + 1}. ${ing.name}${ing.category ? ` (${ing.category})` : ''}`
      if (ing.notes) line += `\n   Owner notes: ${ing.notes}`
      if (ing.own_flavors?.length) line += `\n   Own flavors: ${ing.own_flavors.join(', ')}`
      return line
    })
    .join('\n')

  const prompt = `You are a cocktail and spirits expert. For each ingredient below, provide:
- flavor_affinities: 1-2 sentences describing what flavors and ingredients it pairs well with in cocktails
- spirit_tags: 3-6 short lowercase tags naming SPECIFIC ALCOHOLIC INGREDIENTS that pair well (spirits, liqueurs, wines, vermouths — e.g. "rum", "gin", "raspberry liqueur", "dry vermouth", "champagne"). These should be ingredient names, not flavor descriptors.
- flavor_tags: 4-8 short lowercase tags describing NON-ALCOHOLIC flavor affinities — fruits, botanicals, spices, textures, etc. (e.g. "citrus", "ginger", "raspberry", "honey", "bitter", "stone fruit"). These should be flavor/ingredient descriptors, not spirit names.

If "Owner notes" are provided for an ingredient, treat them as expert supplementary knowledge — incorporate them into your analysis, letting them bias or correct the tags and affinities where relevant. Owner notes take precedence over general knowledge when they conflict.

If "Own flavors" are listed for an ingredient, use them as context when generating pairing suggestions. Do NOT suggest flavors that are dominant or defining characteristics of the spirit itself — those flavors are already present in the drink, so suggesting them as pairings is redundant. You MAY suggest a flavor from Own flavors if it is a subtle accent worth amplifying, but use judgment: if a flavor is central to the spirit's identity, exclude it from the pairing suggestions.

Important: A flavor (like "raspberry") can appear in BOTH spirit_tags (as "raspberry liqueur") AND flavor_tags (as "raspberry") — this is correct and intentional.

Return ONLY a valid JSON array with no extra text or explanation, with exactly one object per ingredient listed below, in the SAME ORDER as listed. Each element must be:
{
  "flavor_affinities": "...",
  "spirit_tags": ["tag1", "tag2", ...],
  "flavor_tags": ["tag1", "tag2", ...]
}

Do NOT include a "name" field — match your response to the input purely by position/order.

Ingredients:
${ingredientList}`

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text()
      throw new Error(`Claude API error: ${claudeRes.status} - ${errBody}`)
    }

    const claudeData = await claudeRes.json()
    const textBlock = (claudeData.content || []).filter(b => b.type === 'text').pop()
    if (!textBlock) throw new Error('No text content in Claude response')

    const parsed = extractJSONArray(textBlock.text)

    if (parsed.length !== ingredients.length) {
      console.warn(`[backfill-affinities] response count mismatch: expected ${ingredients.length}, got ${parsed.length}`)
    }

    const rows = ingredients
      .map((ing, i) => {
        const item = parsed[i]
        if (!item || !item.flavor_affinities) return null
        const spiritTags = Array.isArray(item.spirit_tags) ? item.spirit_tags : []
        const flavorTags = Array.isArray(item.flavor_tags) ? item.flavor_tags : []
        return {
          ingredient_name: ing.name.trim().toLowerCase(),
          category: ing.category || null,
          flavor_affinities: item.flavor_affinities,
          spirit_tags: spiritTags,
          flavor_tags: flavorTags,
          affinity_tags: [...new Set([...spiritTags, ...flavorTags])],
          analyzed_at: new Date().toISOString(),
        }
      })
      .filter(Boolean)

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })

    const { error: upsertErr } = await adminSupabase
      .from('ingredient_affinities')
      .upsert(rows, { onConflict: 'ingredient_name' })

    if (upsertErr) throw new Error(`Supabase upsert error: ${upsertErr.message}`)

    console.log(`[backfill-affinities] stored ${rows.length} ingredient(s)`)
    return res.status(200).json({ success: true, count: rows.length })
  } catch (err) {
    console.error('[backfill-affinities] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
