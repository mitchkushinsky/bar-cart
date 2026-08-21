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

  const { bottles } = req.body || {}
  if (!Array.isArray(bottles) || bottles.length === 0) {
    return res.status(400).json({ error: 'bottles array required' })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[tag-inventory] missing Supabase service-role config')
    return res.status(500).json({ error: 'Missing Supabase service-role config — set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL in env vars' })
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  })

  // Vocabulary convergence: pull the generic_type values already in use so the
  // model can reuse an exact match instead of minting a near-duplicate (e.g.
  // "bourbon whiskey" alongside an existing "bourbon").
  let existingTypes = []
  try {
    const { data, error } = await adminSupabase.from('inventory_tags').select('generic_type')
    if (error) throw error
    existingTypes = Array.from(new Set((data || []).map(r => r.generic_type).filter(Boolean))).sort()
  } catch (err) {
    console.error('[tag-inventory] failed to read existing vocabulary:', err.message)
    return res.status(500).json({ error: `Could not read inventory_tags — has the migration been run? (${err.message})` })
  }

  const bottleList = bottles
    .map((b, i) => `${i + 1}. ${b.name}${b.category ? ` (spreadsheet category: ${b.category})` : ''}`)
    .join('\n')

  const vocabBlock = existingTypes.length > 0
    ? `EXISTING GENERIC TYPES ALREADY IN USE — reuse one of these exactly (same spelling, same wording) when it genuinely fits this bottle. Do not invent a near-duplicate of one of these (e.g. "bourbon whiskey" when "bourbon" is already in use):\n${existingTypes.join(', ')}`
    : `No generic types exist yet — you are establishing the vocabulary. Use short, lowercase, substitutable-class names (e.g. "rye whiskey", "coconut liqueur", "vino amaro", "blanco tequila", "dry vermouth").`

  const prompt = `You are a spirits and cocktail expert building a matching vocabulary for a home bar's inventory. A recipe calls for an ingredient by a generic or category name ("rye whiskey", "coconut liqueur"), while the inventory holds specific bottles ("Rittenhouse", "Clement Mahina Coconut Rhum Liqueur"). Your job is to give each bottle a generic_type and aliases that let a simple, deterministic string match connect the two.

For each bottle below, determine:

- generic_type: the class of bottles a bartender would treat as interchangeable WORKING SUBSTITUTES for this one. The test: if this bottle ran out, what other bottle would you reach for and still consider it basically the same drink? That's generic_type — not shared flavor origin, not the spreadsheet category, and not this bottle's own distinctive character. Lowercase, short (2-5 words).

  Aim broad for genuinely interchangeable siblings: Cardamaro, Barolo Chinato, and Cocchi Dopo Teatro are all "vino amaro" — different producers, same substitutable role in a drink, so a distinctive product's own name belongs in aliases, never in generic_type. Most Italian spirit-based amari (Montenegro, Averna, Nonino, Braulio, Cynar...) converge on plain "amaro," since a bittersweet-template recipe will take any of them. Across a full inventory this should converge on a few dozen types total, not one type per bottle.

  But do not force a shared type onto products that merely resemble each other. A singleton type — one this bottle occupies alone — is correct and expected whenever nothing else in the inventory is a genuine working substitute; "aim broad" means don't fragment genuine siblings, it does not mean avoid being alone. Watch for two specific traps:

  (1) Functional role, not just flavor. A liqueur used in half-ounce-to-ounce quantities and a bitters or tincture used in dashes or drops are never the same type even when they share a flavor — swapping one for the other doesn't just change the accent, it breaks the recipe's structure. A chile liqueur and a habanero tincture are different types. A fruit liqueur and a fruit-flavored bitters are different types.

  (2) Family resemblance is not substitutability. "Herbal" or "bitter" or "spiced" describes dozens of genuinely non-interchangeable products — Jägermeister, Strega, and Genepy are all loosely "herbal liqueurs" but are not working substitutes for each other (wildly different flavor, proof, and use), so each keeps its own type. The same applies within bitters: a classic Angostura-style aromatic bitters is a legitimate broad type among similar competitors (Bogart's, Fee Brothers Old Fashion), but a dash-quantity SPECIALTY bitters — orange, mole, walnut, olive, tiki-spice, smoked, floral — is not a substitute for Angostura or for each other, because the specific flavor is the entire reason to reach for that bottle. Collapsing these erases exactly the information a recipe needs to match on; keep them distinct (or grouped only with a genuinely similar sibling of the same specific flavor).

  Counter-constraint on the other direction — do NOT broaden toward shared flavor origin or ingredient; only toward genuine substitutability. Two products from the same fruit, plant, or flavor family are NOT the same type if swapping one for the other would make a noticeably different drink: maraschino liqueur is not cherry liqueur (dry and almond-like vs. sweet and fruity — not working substitutes for each other), and coconut water or cream of coconut is not coconut liqueur (non-alcoholic, a structurally different role in a recipe). If swapping bottle A for bottle B would make a noticeably different drink, they are different generic_types, even if they're related, made from the same base, or sit in the same spreadsheet category.

- aliases: other names a recipe might call this same product by, including this specific bottle's own distinctive name when it differs from generic_type (e.g. "Cardamaro" itself belongs in Cardamaro's aliases, alongside "vino amaro", "wine amaro"). For a bottle named "Rittenhouse", aliases might be ["rye", "rye whiskey", "straight rye"]. Typically 2-5 aliases; fewer is fine if the product has few common names.

${vocabBlock}

The bottle's spreadsheet "category" (when given) is real but imprecise signal — it's a human-authored display taxonomy that mixes shelf location with product class ("Top Shelf Liqueur", "Bottom Shelf") and bundles unrelated products together ("Brandy / Sherry"). Treat it as a hint, not a source of truth; trust your own knowledge of the specific product, and the substitutability test above, over the category label when they conflict.

Vocabulary convergence is critical: if an existing generic_type genuinely describes this bottle as a working substitute, reuse it exactly. Only introduce a new value when nothing existing is a genuine substitute — this bar has unusual bottles (amari, rhum agricole, aperitivi) that legitimately need new types, so don't force a bad fit just to avoid growing the vocabulary. But err toward the broader existing type when the bottle would plausibly be reached for as a substitute, rather than minting a more precise sub-type for it.

Before minting a new type, check your own aliases for this bottle: if one of the names you'd naturally list as an alias is itself already an existing generic_type (e.g. Calvados's natural aliases include "apple brandy," which may already be in use for other bottles), that is a signal to reuse it as the generic_type instead of creating an appellation- or brand-specific type — the more specific name (Calvados) still belongs in aliases, not generic_type.

Bottles:
${bottleList}

Return ONLY a valid JSON array with no markdown fences, exactly one object per bottle listed above, in the SAME ORDER as listed:
[{ "generic_type": "string", "aliases": ["string", ...] }]`

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

    if (parsed.length !== bottles.length) {
      console.warn(`[tag-inventory] response count mismatch: expected ${bottles.length}, got ${parsed.length}`)
    }

    const rows = bottles
      .map((b, i) => {
        const item = parsed[i]
        if (!item || !item.generic_type) return null
        const aliases = Array.isArray(item.aliases)
          ? Array.from(new Set(item.aliases.map(a => String(a).trim().toLowerCase()).filter(Boolean)))
          : []
        return {
          item_name: b.name.trim().toLowerCase(),
          generic_type: String(item.generic_type).trim().toLowerCase(),
          aliases,
          tagged_at: new Date().toISOString(),
        }
      })
      .filter(Boolean)

    const { error: upsertErr } = await adminSupabase
      .from('inventory_tags')
      .upsert(rows, { onConflict: 'item_name' })

    if (upsertErr) throw new Error(`Supabase upsert error: ${upsertErr.message} — has the inventory_tags migration been run?`)

    console.log(`[tag-inventory] tagged ${rows.length} bottle(s)`)
    return res.status(200).json({ success: true, count: rows.length, tags: rows })
  } catch (err) {
    console.error('[tag-inventory] error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
