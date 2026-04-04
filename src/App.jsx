import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSWHwzLTItnOhFiPSAPObW6iJI1OVnpqiYgoaUzM_KYlzM2MgJsr4zFLpnaY_mB6kOVQLp6edO9xMIB/pub?output=csv'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 1500
const TODAY = 'April 4, 2026'

const EXCLUDE_FROM_INVENTORY = [
  'orange peel', 'lemon twist', 'lemon peel', 'lime wheel', 'lime wedge',
  'citrus peel', 'citrus garnish', 'mint', 'fresh herbs', 'rosemary',
  'sugar', 'salt', 'cream', 'milk', 'egg', 'eggs', 'soda water', 'tonic water',
]

// ─── Colors ──────────────────────────────────────────────────────────────────

const C = {
  bg: '#0f0f0f',
  surface: '#1a1a1a',
  border: '#2a2a2a',
  gold: '#c8a96e',
  green: '#4caf6b',
  amber: '#d4891a',
  red: '#d44f4f',
  blue: '#5090d8',
  text: '#f0ede8',
  textMuted: '#888',
  textFaint: '#555',
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    if (!line.trim()) continue
    const row = []
    let inQuotes = false
    let current = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        row.push(current.trim()); current = ''
      } else {
        current += ch
      }
    }
    row.push(current.trim())
    rows.push(row)
  }
  return rows
}

function parseInventory(csvText) {
  const rows = parseCSV(csvText)
  const items = rows.slice(1).map((row) => ({
    spirit: row[0] || '',
    location: row[1] || '',
    subLocation: row[2] || '',
    category: row[3] || '',
    dateOpened: row[4] || '',
    oos: (row[5] || '').toUpperCase().includes('OOS'),
    notes: row[6] || '',
  }))
  return items.filter((i) => i.spirit)
}

function inventoryToText(items) {
  const lines = ['Spirit | Location | Sub Location | Category | Date Opened | Status | Notes']
  for (const item of items) {
    lines.push(
      `${item.spirit} | ${item.location} | ${item.subLocation} | ${item.category} | ${item.dateOpened || 'N/A'} | ${item.oos ? 'OOS' : 'Available'} | ${item.notes}`
    )
  }
  return lines.join('\n')
}

// ─── Claude API ───────────────────────────────────────────────────────────────

function extractJSON(text) {
  const t = text.trim()
  try { return JSON.parse(t) } catch (_) { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) try { return JSON.parse(fenced[1]) } catch (_) { /* fall through */ }
  const obj = t.match(/\{[\s\S]*\}/)
  if (obj) try { return JSON.parse(obj[0]) } catch (_) { /* fall through */ }
  throw new Error('Could not parse JSON from Claude response')
}

async function callClaude(body) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  const textBlock = (data.content || []).filter((b) => b.type === 'text').pop()
  if (!textBlock) throw new Error('No text content in Claude response')
  return extractJSON(textBlock.text)
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target.result
      resolve({ base64: dataUrl.split(',')[1], mediaType: file.type || 'image/jpeg' })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function applyGarnishFilter(data) {
  if (Array.isArray(data.ingredients)) {
    data.ingredients = data.ingredients.filter(item =>
      !EXCLUDE_FROM_INVENTORY.some(term => item.ingredient.toLowerCase().includes(term))
    )
  }
  return data
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function sharedPromptSuffix(inventoryText) {
  return `Today's date is ${TODAY}.

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE (apply when Date Opened is not "N/A"):
- Vermouth: 1 month unrefrigerated / 3 months refrigerated after opening
- Simple syrup: 2–4 weeks room temp / 1–2 months refrigerated
- Amaro: 6–12 months after opening
- Commercial liqueurs: generally stable 6+ months

For shelf warnings, always calculate and state the specific expiration date, not a duration. For example: "Opened 1/1/2026 — best by approximately 4/1/2026 (refrigerated)" or "Opened 1/1/2026 — expired approximately 2/1/2026, consider replacing." Never say "still good for X months" — always give the actual date.

Common fresh garnishes (orange peel, lemon twist, lime wheel, citrus peels, fresh herbs) and pantry staples (sugar, salt, cream, milk, eggs, soda water) should appear in the recipe array with their amounts as normal, but must be excluded from the ingredients array entirely. Do not check them against inventory.

Return ONLY valid JSON with no markdown fences, no extra text. Use this exact structure:
{
  "recipe_name": "string",
  "recipe": [{ "ingredient": "string", "amount": "string" }],
  "instructions": "string",
  "summary": "1-2 sentence overall assessment of whether they can make this",
  "ingredients": [
    {
      "ingredient": "string",
      "inferred": false,
      "status": "found | substitute | missing",
      "location": "Primary / Sub Location if found, else null",
      "shelf_warning": "string or null",
      "refrigerate_tip": "string or null",
      "substitute": "best in-inventory substitute if missing or OOS, else null",
      "substitute_location": "location of substitute, else null",
      "flavor_impact": "how substitute changes the drink, else null",
      "notes": "any other note, else null"
    }
  ],
  "variations": [
    { "name": "string", "description": "string", "changes": "string" }
  ]
}`
}

async function analyzeRecipePhoto(imageFile, inventoryText) {
  const { base64, mediaType } = await fileToBase64(imageFile)
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: `The image shows a cocktail recipe. Extract the recipe name and all ingredients with amounts directly from the image. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}` },
      ],
    }],
  }
  return { data: await callClaude(body), body }
}

async function analyzeCocktailName(name, inventoryText) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Use web search to look up the canonical recipe for the cocktail "${name}". This is especially important for obscure or modern cocktails where training data may be inaccurate. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
    }],
  }
  return { data: await callClaude(body), body }
}

async function parseMenuCocktails(imageFile) {
  const { base64, mediaType } = await fileToBase64(imageFile)
  return callClaude({
    model: MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'This image shows a cocktail menu. Return ONLY a JSON object with no markdown fences. Use this exact structure: {"cocktails": ["name1", "name2"]}. List every cocktail name found on the menu in the order they appear. No extra text.' },
      ],
    }],
  })
}

async function analyzeBarMenu(menuFile, cocktailName, inventoryText, cocktailPhotoFile) {
  const { base64, mediaType } = await fileToBase64(menuFile)
  const content = [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }]
  if (cocktailPhotoFile) {
    const { base64: b2, mediaType: mt2 } = await fileToBase64(cocktailPhotoFile)
    content.push({ type: 'image', source: { type: 'base64', media_type: mt2, data: b2 } })
    content.push({ type: 'text', text: 'The second image is a photo of the actual cocktail as served — use it to help infer ingredients, color, garnish, and glassware.' })
  }
  content.push({
    type: 'text',
    text: `The first image shows a bar menu. Find the cocktail named "${cocktailName}" in the menu. Read its description carefully and infer the most likely ingredients from it. Set "inferred": true for any ingredient you are inferring from a vague description rather than one that is explicitly listed. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
  })
  const body = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }
  return { data: await callClaude(body), body }
}

// ─── Shared small components ──────────────────────────────────────────────────

function Chip({ color, children }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: 4,
      background: color + '22', color, border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  )
}

function UploadZone({ file, onFile, onRemove }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef()
  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) onFile(f)
  }, [onFile])
  const handleDragOver = useCallback((e) => { e.preventDefault(); setDragging(true) }, [])
  const handleDragLeave = useCallback(() => setDragging(false), [])
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  if (file && preview) {
    return (
      <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
        <img src={preview} alt="Preview" style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 10, border: `1px solid ${C.border}`, display: 'block' }} />
        <button onClick={onRemove} style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.8)', border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>
          Remove
        </button>
      </div>
    )
  }
  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onClick={() => inputRef.current?.click()} style={{ border: `2px dashed ${dragging ? C.gold : C.border}`, borderRadius: 12, padding: '40px 24px', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s', background: dragging ? C.gold + '10' : 'transparent', userSelect: 'none' }}>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]) }} />
      <div style={{ fontSize: 36, marginBottom: 12, lineHeight: 1 }}>📁</div>
      <div style={{ color: C.textMuted, fontSize: 14 }}>
        Drag & drop an image here, or <span style={{ color: C.gold, textDecoration: 'underline' }}>click to browse</span>
      </div>
    </div>
  )
}

// ─── Ingredient Card ──────────────────────────────────────────────────────────

function IngredientCard({ item, shoppingList, onAddToList }) {
  const isExpired = (() => {
    if (!item.shelf_warning) return false
    const match = item.shelf_warning.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
    if (!match) return false
    const now = new Date(); now.setHours(0, 0, 0, 0)
    return new Date(+match[3], +match[1] - 1, +match[2]) < now
  })()
  const inList = shoppingList.some(s => s.name.toLowerCase() === item.ingredient.toLowerCase())
  const dotColor = item.status === 'found' ? C.green : item.status === 'substitute' ? C.amber : C.red

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: dotColor, flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{item.ingredient}</span>
            {item.status === 'missing' && <Chip color={C.red}>missing</Chip>}
            {item.status === 'substitute' && <Chip color={C.amber}>substitute</Chip>}
            {(item.status === 'missing' || item.status === 'substitute') && !inList && (
              <button onClick={() => onAddToList(item.ingredient)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, color: C.textMuted, fontSize: 11, padding: '2px 7px', cursor: 'pointer' }}>
                + Add to List
              </button>
            )}
            {(item.status === 'missing' || item.status === 'substitute') && inList && (
              <span style={{ fontSize: 11, color: C.textFaint }}>✓ On list</span>
            )}
          </div>
          {item.location && (
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>📍 {item.location}</div>
          )}
          {item.shelf_warning && (
            <div style={{ fontSize: 13, color: C.amber, background: C.amber + '12', border: `1px solid ${C.amber}33`, borderRadius: 6, padding: '5px 10px', marginTop: 8 }}>
              ⚠️ {item.shelf_warning}
              {isExpired && (
                <span style={{ marginLeft: 8, color: C.textFaint, fontSize: 11 }}>
                  {inList ? '· Added to shopping list' : (
                    <button onClick={() => onAddToList(item.ingredient)} style={{ background: 'none', border: 'none', color: C.gold, fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                      Add to shopping list
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
          {item.refrigerate_tip && (
            <div style={{ fontSize: 13, color: C.blue, background: C.blue + '12', border: `1px solid ${C.blue}33`, borderRadius: 6, padding: '5px 10px', marginTop: 8 }}>
              ❄️ {item.refrigerate_tip}
            </div>
          )}
          {(item.substitute || item.flavor_impact) && (
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8, fontStyle: 'italic' }}>
              {item.substitute && (
                <>Sub: <span style={{ color: C.gold }}>{item.substitute}</span>{item.substitute_location && <span style={{ color: C.textFaint }}> ({item.substitute_location})</span>}{item.flavor_impact && ' — '}</>
              )}
              {item.flavor_impact && <span>{item.flavor_impact}</span>}
            </div>
          )}
          {item.notes && <div style={{ fontSize: 13, color: C.textFaint, marginTop: 6 }}>{item.notes}</div>}
        </div>
      </div>
    </div>
  )
}

function VariationCard({ variation }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 5 }}>{variation.name}</div>
      {variation.description && <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{variation.description}</div>}
      {variation.changes && <div style={{ fontSize: 13, color: C.gold, fontStyle: 'italic' }}>{variation.changes}</div>}
    </div>
  )
}

// ─── Results ──────────────────────────────────────────────────────────────────

function Results({ result, shoppingList, onAddToList, favorites, onToggleFavorite, onFeedback, feedbackLoading }) {
  const [tab, setTab] = useState('ingredients')
  const [feedbackText, setFeedbackText] = useState('')
  const ingredientCount = result.ingredients?.length || 0
  const variationCount = result.variations?.length || 0
  const isFav = favorites.some(f => f.id === result._favId || f.recipeName === result.recipe_name)

  const handleFeedbackSubmit = () => {
    if (!feedbackText.trim()) return
    onFeedback(feedbackText.trim())
    setFeedbackText('')
  }

  return (
    <div style={{ marginTop: 36 }}>
      {/* Name + favorite */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <h2 style={{ flex: 1, fontSize: 26, fontWeight: 800, color: C.gold, letterSpacing: '-0.03em', lineHeight: 1.2, minWidth: 0 }}>
          {result.recipe_name}
        </h2>
        <button
          onClick={() => onToggleFavorite(result)}
          style={{ background: 'none', border: `1px solid ${isFav ? C.gold : C.border}`, borderRadius: 20, color: isFav ? C.gold : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, transition: 'color 0.15s, border-color 0.15s' }}
        >
          {isFav ? '♥ Saved' : '♡ Save to Favorites'}
        </button>
      </div>

      {result.summary && (
        <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24, lineHeight: 1.65, maxWidth: 600 }}>
          {result.summary}
        </p>
      )}

      {/* Canonical recipe */}
      {result.recipe && result.recipe.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px', marginBottom: 28 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 14 }}>Recipe</div>
          <ul style={{ listStyle: 'none' }}>
            {result.recipe.map((r, i) => (
              <li key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0', borderBottom: i < result.recipe.length - 1 ? `1px solid ${C.border}` : 'none', gap: 16 }}>
                <span style={{ fontSize: 15 }}>{r.ingredient}</span>
                <span style={{ fontSize: 14, color: C.gold, fontWeight: 500, whiteSpace: 'nowrap' }}>{r.amount}</span>
              </li>
            ))}
          </ul>
          {result.instructions && (
            <p style={{ fontSize: 14, color: C.textMuted, marginTop: 14, lineHeight: 1.65, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              {result.instructions}
            </p>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {[{ id: 'ingredients', label: `Ingredients (${ingredientCount})` }, { id: 'variations', label: `Variations (${variationCount})` }].map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{ background: 'none', border: 'none', borderBottom: tab === id ? `2px solid ${C.gold}` : '2px solid transparent', color: tab === id ? C.gold : C.textMuted, fontSize: 14, fontWeight: tab === id ? 600 : 400, padding: '8px 16px', cursor: 'pointer', marginBottom: -1, transition: 'color 0.15s' }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'ingredients' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(result.ingredients || []).map((item, i) => (
            <IngredientCard key={i} item={item} shoppingList={shoppingList} onAddToList={onAddToList} />
          ))}
        </div>
      )}
      {tab === 'variations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {variationCount === 0
            ? <p style={{ color: C.textMuted, fontSize: 14 }}>No variations suggested.</p>
            : (result.variations || []).map((v, i) => <VariationCard key={i} variation={v} />)
          }
        </div>
      )}

      {/* Feedback */}
      <div style={{ marginTop: 32, paddingTop: 24, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 13, color: C.textFaint, marginBottom: 10 }}>Something off? Describe what to adjust:</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !feedbackLoading && handleFeedbackSubmit()}
            placeholder="e.g. I also have Aperol on hand — suggest a variation"
            style={{ flex: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '9px 12px', fontSize: 13, outline: 'none' }}
          />
          <button
            onClick={handleFeedbackSubmit}
            disabled={!feedbackText.trim() || feedbackLoading}
            style={{ background: feedbackText.trim() && !feedbackLoading ? C.gold : C.surface, border: `1px solid ${feedbackText.trim() && !feedbackLoading ? C.gold : C.border}`, borderRadius: 8, color: feedbackText.trim() && !feedbackLoading ? '#0f0f0f' : C.textFaint, fontSize: 13, fontWeight: 600, padding: '9px 14px', cursor: feedbackText.trim() && !feedbackLoading ? 'pointer' : 'default', whiteSpace: 'nowrap', transition: 'background 0.15s, color 0.15s' }}
          >
            {feedbackLoading ? 'Adjusting…' : 'Something Off? Adjust'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inventory Screen ─────────────────────────────────────────────────────────

function InventoryScreen({ inventory, inStockCount, oosCount }) {
  if (!inventory) return <p style={{ color: C.textMuted, fontSize: 14 }}>Inventory not loaded.</p>

  const groups = {}
  for (const item of inventory) {
    const loc = item.location || 'Unknown'
    if (!groups[loc]) groups[loc] = []
    groups[loc].push(item)
  }
  const sortedLocs = Object.keys(groups).sort()

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{inStockCount} in stock</span>
        {oosCount > 0 && <span style={{ fontSize: 13, background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{oosCount} OOS</span>}
      </div>
      {sortedLocs.map(loc => (
        <div key={loc} style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 10 }}>{loc}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {groups[loc].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.surface, borderRadius: 8, flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: item.oos ? C.amber : C.green, flexShrink: 0 }} />
                <span style={{ fontSize: 14, flex: 1, minWidth: 120 }}>{item.spirit}</span>
                {item.subLocation && <span style={{ fontSize: 12, color: C.textMuted }}>{item.subLocation}</span>}
                {item.category && <span style={{ fontSize: 11, color: C.textFaint, background: C.border, borderRadius: 4, padding: '2px 6px' }}>{item.category}</span>}
                {item.oos && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>OOS</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Shopping List Screen ─────────────────────────────────────────────────────

function ShoppingListScreen({ shoppingList, onRemove, onClear }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const text = shoppingList.map(i => `• ${i.name}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (_) { /* clipboard not available */ }
  }

  if (shoppingList.length === 0) {
    return <p style={{ color: C.textMuted, fontSize: 14 }}>Your shopping list is empty. Missing or expired ingredients will appear here.</p>
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button onClick={handleCopy} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: copied ? C.green : C.text, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}>
          {copied ? '✓ Copied' : 'Copy List'}
        </button>
        <button onClick={onClear} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}>
          Clear All
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shoppingList.map(item => (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px' }}>
            <span style={{ flex: 1, fontSize: 14 }}>{item.name}</span>
            <button onClick={() => onRemove(item.id)} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Favorites Screen ─────────────────────────────────────────────────────────

function FavoritesScreen({ favorites, onRemove, onView }) {
  if (favorites.length === 0) {
    return <p style={{ color: C.textMuted, fontSize: 14 }}>No saved favorites yet. Analyze a recipe and tap ♡ Save to Favorites.</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {favorites.map(fav => (
        <div key={fav.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.gold, marginBottom: 4 }}>{fav.recipeName}</div>
              {fav.summary && <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{fav.summary}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button onClick={() => onView(fav)} style={{ background: C.gold, border: 'none', borderRadius: 7, color: '#0f0f0f', fontSize: 12, fontWeight: 700, padding: '6px 12px', cursor: 'pointer' }}>
                View
              </button>
              <button onClick={() => onRemove(fav.id)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textFaint, fontSize: 18, padding: '2px 8px', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
          </div>
          {fav.recipe && fav.recipe.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: C.textFaint }}>
              {fav.recipe.slice(0, 3).map(r => r.ingredient).join(', ')}{fav.recipe.length > 3 ? ` +${fav.recipe.length - 3} more` : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // Inventory
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL)
  const [sheetUrlInput, setSheetUrlInput] = useState(DEFAULT_SHEET_URL)
  const [inventory, setInventory] = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [inventoryError, setInventoryError] = useState(null)

  // Navigation
  const [screen, setScreen] = useState('main') // 'main' | 'inventory' | 'shopping' | 'favorites'

  // Persisted state
  const [shoppingList, setShoppingList] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-shopping')) || [] } catch { return [] }
  })
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-favorites')) || [] } catch { return [] }
  })

  useEffect(() => { localStorage.setItem('bar-cart-shopping', JSON.stringify(shoppingList)) }, [shoppingList])
  useEffect(() => { localStorage.setItem('bar-cart-favorites', JSON.stringify(favorites)) }, [favorites])

  // Input mode
  const [mode, setMode] = useState('photo')
  const [recipePhoto, setRecipePhoto] = useState(null)
  const [cocktailName, setCocktailName] = useState('')
  const [menuPhoto, setMenuPhoto] = useState(null)
  const [menuStep, setMenuStep] = useState('upload')
  const [menuCocktails, setMenuCocktails] = useState([])
  const [menuSelectedCocktail, setMenuSelectedCocktail] = useState('')
  const [menuCocktailPhoto, setMenuCocktailPhoto] = useState(null)

  // Analysis
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [lastRequestBody, setLastRequestBody] = useState(null)
  const [feedbackLoading, setFeedbackLoading] = useState(false)

  // Inventory loading
  const loadInventory = useCallback(async (url) => {
    setInventoryLoading(true); setInventoryError(null); setInventory(null)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setInventory(parseInventory(await res.text()))
    } catch (err) {
      setInventoryError(err.message)
    } finally {
      setInventoryLoading(false)
    }
  }, [])

  useEffect(() => { loadInventory(sheetUrl) }, [sheetUrl, loadInventory])

  const handleReload = () => {
    if (sheetUrlInput === sheetUrl) loadInventory(sheetUrlInput)
    else setSheetUrl(sheetUrlInput)
  }

  const inStockCount = inventory ? inventory.filter(i => !i.oos).length : 0
  const oosCount = inventory ? inventory.filter(i => i.oos).length : 0

  // Shopping list helpers
  const addToShopping = useCallback((name) => {
    setShoppingList(prev => {
      if (prev.some(i => i.name.toLowerCase() === name.toLowerCase())) return prev
      return [...prev, { id: Date.now() + Math.random(), name }]
    })
  }, [])

  const removeFromShopping = (id) => setShoppingList(prev => prev.filter(i => i.id !== id))
  const clearShopping = () => setShoppingList([])

  // Favorites helpers
  const toggleFavorite = (res) => {
    setFavorites(prev => {
      const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
      if (existing >= 0) return prev.filter((_, i) => i !== existing)
      return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, ingredients: res.ingredients, variations: res.variations, savedAt: new Date().toISOString() }, ...prev]
    })
  }

  const removeFavorite = (id) => setFavorites(prev => prev.filter(f => f.id !== id))

  const viewFavorite = (fav) => {
    setResult({ recipe_name: fav.recipeName, summary: fav.summary, recipe: fav.recipe, ingredients: fav.ingredients, variations: fav.variations })
    setScreen('main')
  }

  // Analyze
  const canAnalyze = () => {
    if (!inventory || inventoryLoading || loading) return false
    if (mode === 'photo') return !!recipePhoto
    if (mode === 'name') return cocktailName.trim().length > 0
    if (mode === 'menu') return menuStep === 'upload' ? !!menuPhoto : menuStep === 'ready'
    return false
  }

  const processResult = useCallback((data) => {
    const filtered = applyGarnishFilter(data)
    // Auto-add ingredients whose shelf date has passed
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    if (Array.isArray(filtered.ingredients)) {
      filtered.ingredients.forEach(item => {
        if (!item.shelf_warning) return
        const match = item.shelf_warning.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
        if (match) {
          const date = new Date(+match[3], +match[1] - 1, +match[2])
          if (date < now) addToShopping(item.ingredient)
        }
      })
    }
    return filtered
  }, [addToShopping])

  const handleAnalyze = async () => {
    if (!canAnalyze()) return
    setLoading(true); setError(null); setResult(null)
    const menuParseStep = mode === 'menu' && menuStep === 'upload'
    setLoadingMsg(menuParseStep ? 'Reading menu…' : mode === 'photo' ? 'Analyzing recipe…' : mode === 'name' ? 'Looking up cocktail…' : 'Analyzing cocktail…')

    try {
      if (menuParseStep) {
        const parsed = await parseMenuCocktails(menuPhoto)
        setMenuCocktails(Array.isArray(parsed?.cocktails) ? parsed.cocktails : [])
        setMenuStep('selecting')
        setLoading(false)
        return
      }
      const inventoryText = inventoryToText(inventory)
      let response
      if (mode === 'photo') response = await analyzeRecipePhoto(recipePhoto, inventoryText)
      else if (mode === 'name') response = await analyzeCocktailName(cocktailName.trim(), inventoryText)
      else response = await analyzeBarMenu(menuPhoto, menuSelectedCocktail, inventoryText, menuCocktailPhoto)
      setLastRequestBody(response.body)
      setResult(processResult(response.data))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleFeedback = async (feedbackText) => {
    if (!lastRequestBody || !result) return
    setFeedbackLoading(true); setError(null)
    try {
      const feedbackBody = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          ...lastRequestBody.messages,
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: `The user reviewed this analysis and provided this feedback: ${feedbackText}. Please revise your response accordingly and return the same JSON structure.` },
        ],
      }
      const revised = await callClaude(feedbackBody)
      setLastRequestBody(feedbackBody)
      setResult(processResult(revised))
    } catch (err) {
      setError(err.message)
    } finally {
      setFeedbackLoading(false)
    }
  }

  const changeMode = (m) => {
    setMode(m); setResult(null); setError(null); setLastRequestBody(null)
    setMenuPhoto(null); setMenuStep('upload'); setMenuCocktails([]); setMenuSelectedCocktail(''); setMenuCocktailPhoto(null)
  }

  const MODES = [
    { id: 'photo', label: '📷 Recipe Photo' },
    { id: 'name', label: '⌨️ Cocktail Name' },
    { id: 'menu', label: '🍹 Bar Menu' },
  ]

  const NAV_PILLS = [
    { id: 'inventory', label: 'Inventory', count: inStockCount, countColor: C.green },
    { id: 'shopping', label: 'Shopping List', count: shoppingList.length, countColor: C.amber },
    { id: 'favorites', label: 'Favorites', count: favorites.length, countColor: C.gold },
  ]

  const toggleScreen = (s) => setScreen(prev => prev === s ? 'main' : s)

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 20px 80px' }}>

      {/* Header */}
      <div style={{ padding: '24px 0 18px', borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div onClick={() => setScreen('main')} style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.04em', color: C.gold, cursor: 'pointer' }}>Bar Cart</div>
            <div style={{ fontSize: 13, color: C.textFaint, marginTop: 2 }}>home cocktail assistant</div>
          </div>
          {inventoryLoading && <span style={{ fontSize: 13, color: C.textFaint }}>Loading inventory…</span>}
          {inventoryError && <span style={{ fontSize: 12, background: C.red + '22', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 20, padding: '3px 10px' }}>Inventory error</span>}
        </div>

        {/* Nav pills */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {NAV_PILLS.map(({ id, label, count, countColor }) => {
            const active = screen === id
            return (
              <button
                key={id}
                onClick={() => toggleScreen(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: active ? countColor + '22' : C.surface,
                  border: `1px solid ${active ? countColor + '55' : C.border}`,
                  borderRadius: 20, color: active ? countColor : C.textMuted,
                  fontSize: 13, fontWeight: active ? 600 : 400,
                  padding: '5px 12px', cursor: 'pointer',
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
              >
                {label}
                <span style={{ fontSize: 11, fontWeight: 700, background: countColor + '33', color: countColor, borderRadius: 10, padding: '1px 6px' }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Inventory URL row — always visible */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <input
          type="text"
          value={sheetUrlInput}
          onChange={(e) => setSheetUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleReload()}
          placeholder="Google Sheet CSV URL"
          style={{ flex: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '8px 12px', fontSize: 13, outline: 'none' }}
        />
        <button
          onClick={handleReload}
          disabled={inventoryLoading}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: inventoryLoading ? C.textFaint : C.text, padding: '8px 14px', fontSize: 13, cursor: inventoryLoading ? 'default' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {inventoryLoading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {inventoryError && (
        <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.red, marginBottom: 20 }}>
          Failed to load inventory: {inventoryError}
        </div>
      )}

      {/* Screen: Inventory */}
      {screen === 'inventory' && (
        <InventoryScreen inventory={inventory} inStockCount={inStockCount} oosCount={oosCount} />
      )}

      {/* Screen: Shopping List */}
      {screen === 'shopping' && (
        <ShoppingListScreen shoppingList={shoppingList} onRemove={removeFromShopping} onClear={clearShopping} />
      )}

      {/* Screen: Favorites */}
      {screen === 'favorites' && (
        <FavoritesScreen favorites={favorites} onRemove={removeFavorite} onView={viewFavorite} />
      )}

      {/* Screen: Main */}
      {screen === 'main' && (
        <>
          {/* Mode tabs */}
          <div style={{ display: 'flex', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, gap: 4, marginBottom: 20 }}>
            {MODES.map(({ id, label }) => (
              <button key={id} onClick={() => changeMode(id)} style={{ flex: 1, background: mode === id ? C.gold : 'transparent', border: 'none', borderRadius: 7, color: mode === id ? '#0f0f0f' : C.textMuted, fontWeight: mode === id ? 700 : 400, fontSize: 13, padding: '9px 6px', cursor: 'pointer', transition: 'background 0.15s, color 0.15s' }}>
                {label}
              </button>
            ))}
          </div>

          {/* Mode content */}
          <div style={{ marginBottom: 16 }}>
            {mode === 'photo' && (
              <UploadZone file={recipePhoto} onFile={setRecipePhoto} onRemove={() => setRecipePhoto(null)} />
            )}
            {mode === 'name' && (
              <input
                type="text"
                value={cocktailName}
                onChange={(e) => setCocktailName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canAnalyze() && handleAnalyze()}
                placeholder="e.g. Naked and Famous"
                autoFocus
                style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: '14px 16px', fontSize: 16, outline: 'none' }}
              />
            )}
            {mode === 'menu' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {menuStep === 'upload' && (
                  <UploadZone file={menuPhoto} onFile={setMenuPhoto} onRemove={() => setMenuPhoto(null)} />
                )}
                {(menuStep === 'selecting' || menuStep === 'ready') && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 13, color: C.textMuted }}>{menuCocktails.length} cocktail{menuCocktails.length !== 1 ? 's' : ''} found — tap one to select</div>
                      <button onClick={() => { setMenuStep('upload'); setMenuCocktails([]); setMenuSelectedCocktail(''); setMenuCocktailPhoto(null) }} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0 }}>← new menu</button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {menuCocktails.map(name => {
                        const selected = name === menuSelectedCocktail
                        return (
                          <button key={name} onClick={() => { setMenuSelectedCocktail(name); setMenuStep('ready'); setResult(null); setError(null) }} style={{ background: selected ? C.gold : C.surface, border: `1px solid ${selected ? C.gold : C.border}`, borderRadius: 20, color: selected ? '#0f0f0f' : C.text, fontSize: 13, fontWeight: selected ? 700 : 400, padding: '6px 14px', cursor: 'pointer', transition: 'background 0.15s, color 0.15s, border-color 0.15s' }}>
                            {name}
                          </button>
                        )
                      })}
                    </div>
                    {menuStep === 'ready' && (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: C.gold }}>{menuSelectedCocktail}</div>
                        <div>
                          <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 8 }}>Add a photo of the cocktail (optional) — helps with replication</div>
                          {menuCocktailPhoto ? (
                            <div style={{ position: 'relative', display: 'inline-block' }}>
                              <img src={URL.createObjectURL(menuCocktailPhoto)} alt="Cocktail preview" style={{ maxHeight: 160, borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' }} />
                              <button onClick={() => setMenuCocktailPhoto(null)} style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.8)', border: `1px solid ${C.border}`, color: C.text, borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>Remove</button>
                            </div>
                          ) : (
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px dashed ${C.border}`, borderRadius: 8, padding: '10px 14px', cursor: 'pointer', color: C.textMuted, fontSize: 13 }}>
                              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { if (e.target.files[0]) setMenuCocktailPhoto(e.target.files[0]) }} />
                              <span style={{ fontSize: 18 }}>🍸</span>
                              Click to add cocktail photo
                            </label>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Analyze button */}
          <button
            onClick={handleAnalyze}
            disabled={!canAnalyze()}
            style={{ width: '100%', background: canAnalyze() ? C.gold : C.surface, border: `1px solid ${canAnalyze() ? C.gold : C.border}`, borderRadius: 10, color: canAnalyze() ? '#0f0f0f' : C.textFaint, fontWeight: 700, fontSize: 15, padding: '13px', cursor: canAnalyze() ? 'pointer' : 'default', transition: 'background 0.15s, color 0.15s, border-color 0.15s' }}
          >
            {loading ? loadingMsg : 'Analyze'}
          </button>

          {/* Error */}
          {error && (
            <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.red, marginTop: 16 }}>
              {error}
            </div>
          )}

          {/* Loading spinner */}
          {loading && (
            <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 14, marginTop: 32, padding: '24px 0' }}>
              <style>{`@keyframes bcspin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ display: 'inline-block', width: 30, height: 30, border: `3px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'bcspin 0.75s linear infinite', marginBottom: 12 }} />
              <div>{loadingMsg}</div>
            </div>
          )}

          {/* Results */}
          {result && !loading && (
            <Results
              result={result}
              shoppingList={shoppingList}
              onAddToList={addToShopping}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onFeedback={handleFeedback}
              feedbackLoading={feedbackLoading}
            />
          )}
        </>
      )}
    </div>
  )
}
