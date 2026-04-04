import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSWHwzLTItnOhFiPSAPObW6iJI1OVnpqiYgoaUzM_KYlzM2MgJsr4zFLpnaY_mB6kOVQLp6edO9xMIB/pub?output=csv'

const MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 1500
const TODAY = 'April 3, 2026'

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
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        row.push(current.trim())
        current = ''
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
  const lines = [
    'Spirit | Location | Sub Location | Category | Date Opened | Status | Notes',
  ]
  for (const item of items) {
    const status = item.oos ? 'OOS' : 'Available'
    lines.push(
      `${item.spirit} | ${item.location} | ${item.subLocation} | ${item.category} | ${item.dateOpened || 'N/A'} | ${status} | ${item.notes}`
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
  return callClaude({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `The image shows a cocktail recipe. Extract the recipe name and all ingredients with amounts directly from the image. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
        },
      ],
    }],
  })
}

async function analyzeCocktailName(name, inventoryText) {
  return callClaude({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Use web search to look up the canonical recipe for the cocktail "${name}". This is especially important for obscure or modern cocktails where training data may be inaccurate. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
    }],
  })
}

async function analyzeBarMenu(imageFile, cocktailName, inventoryText) {
  const { base64, mediaType } = await fileToBase64(imageFile)
  return callClaude({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `The image shows a bar menu. Find the cocktail named "${cocktailName}" in the menu. Read its description carefully and infer the most likely ingredients from it. Set "inferred": true for any ingredient you are inferring from a vague description rather than one that is explicitly listed. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
        },
      ],
    }],
  })
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({ color, children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.02em',
      padding: '3px 9px',
      borderRadius: 20,
      background: color + '22',
      color,
      border: `1px solid ${color}55`,
    }}>
      {children}
    </span>
  )
}

// ─── UploadZone ───────────────────────────────────────────────────────────────

function UploadZone({ file, onFile, onRemove }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef()

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
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
        <img
          src={preview}
          alt="Preview"
          style={{
            maxWidth: '100%',
            maxHeight: 280,
            borderRadius: 10,
            border: `1px solid ${C.border}`,
            display: 'block',
          }}
        />
        <button
          onClick={onRemove}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(0,0,0,0.8)',
            border: `1px solid ${C.border}`,
            color: C.text,
            borderRadius: 6,
            padding: '3px 10px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Remove
        </button>
      </div>
    )
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? C.gold : C.border}`,
        borderRadius: 12,
        padding: '40px 24px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
        background: dragging ? C.gold + '10' : 'transparent',
        userSelect: 'none',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]) }}
      />
      <div style={{ fontSize: 36, marginBottom: 12, lineHeight: 1 }}>📁</div>
      <div style={{ color: C.textMuted, fontSize: 14 }}>
        Drag & drop an image here, or{' '}
        <span style={{ color: C.gold, textDecoration: 'underline' }}>click to browse</span>
      </div>
    </div>
  )
}

// ─── Results ──────────────────────────────────────────────────────────────────

function StatusDot({ status }) {
  const color = status === 'found' ? C.green : status === 'substitute' ? C.amber : C.red
  return (
    <span style={{
      display: 'inline-block',
      width: 9,
      height: 9,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
      marginTop: 3,
    }} />
  )
}

function Chip({ color, children }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      padding: '2px 7px',
      borderRadius: 4,
      background: color + '22',
      color,
      border: `1px solid ${color}44`,
    }}>
      {children}
    </span>
  )
}

function IngredientCard({ item }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <StatusDot status={item.status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{item.ingredient}</span>
{item.status === 'missing' && <Chip color={C.red}>missing</Chip>}
            {item.status === 'substitute' && <Chip color={C.amber}>substitute</Chip>}
          </div>
          {item.location && (
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>
              📍 {item.location}
            </div>
          )}

          {item.shelf_warning && (
            <div style={{
              fontSize: 13,
              color: C.amber,
              background: C.amber + '12',
              border: `1px solid ${C.amber}33`,
              borderRadius: 6,
              padding: '5px 10px',
              marginTop: 8,
            }}>
              ⚠️ {item.shelf_warning}
            </div>
          )}

          {item.refrigerate_tip && (
            <div style={{
              fontSize: 13,
              color: C.blue,
              background: C.blue + '12',
              border: `1px solid ${C.blue}33`,
              borderRadius: 6,
              padding: '5px 10px',
              marginTop: 8,
            }}>
              ❄️ {item.refrigerate_tip}
            </div>
          )}

          {(item.substitute || item.flavor_impact) && (
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8, fontStyle: 'italic' }}>
              {item.substitute && (
                <>
                  Sub: <span style={{ color: C.gold }}>{item.substitute}</span>
                  {item.substitute_location && (
                    <span style={{ color: C.textFaint }}> ({item.substitute_location})</span>
                  )}
                  {item.flavor_impact && ' — '}
                </>
              )}
              {item.flavor_impact && <span>{item.flavor_impact}</span>}
            </div>
          )}

          {item.notes && (
            <div style={{ fontSize: 13, color: C.textFaint, marginTop: 6 }}>{item.notes}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function VariationCard({ variation }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '14px 16px',
    }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 5 }}>{variation.name}</div>
      {variation.description && (
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{variation.description}</div>
      )}
      {variation.changes && (
        <div style={{ fontSize: 13, color: C.gold, fontStyle: 'italic' }}>{variation.changes}</div>
      )}
    </div>
  )
}

function Results({ result }) {
  const [tab, setTab] = useState('ingredients')
  const ingredientCount = result.ingredients?.length || 0
  const variationCount = result.variations?.length || 0

  return (
    <div style={{ marginTop: 36 }}>
      <h2 style={{
        fontSize: 26,
        fontWeight: 800,
        color: C.gold,
        marginBottom: 10,
        letterSpacing: '-0.03em',
        lineHeight: 1.2,
      }}>
        {result.recipe_name}
      </h2>

      {result.summary && (
        <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24, lineHeight: 1.65, maxWidth: 600 }}>
          {result.summary}
        </p>
      )}

      {/* Canonical recipe card */}
      {result.recipe && result.recipe.length > 0 && (
        <div style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '18px 20px',
          marginBottom: 28,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: C.textFaint,
            marginBottom: 14,
          }}>
            Recipe
          </div>
          <ul style={{ listStyle: 'none' }}>
            {result.recipe.map((r, i) => (
              <li key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                padding: '6px 0',
                borderBottom: i < result.recipe.length - 1 ? `1px solid ${C.border}` : 'none',
                gap: 16,
              }}>
                <span style={{ fontSize: 15 }}>{r.ingredient}</span>
                <span style={{ fontSize: 14, color: C.gold, fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {r.amount}
                </span>
              </li>
            ))}
          </ul>
          {result.instructions && (
            <p style={{
              fontSize: 14,
              color: C.textMuted,
              marginTop: 14,
              lineHeight: 1.65,
              borderTop: `1px solid ${C.border}`,
              paddingTop: 14,
            }}>
              {result.instructions}
            </p>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{
        display: 'flex',
        borderBottom: `1px solid ${C.border}`,
        marginBottom: 16,
        gap: 0,
      }}>
        {[
          { id: 'ingredients', label: `Ingredients (${ingredientCount})` },
          { id: 'variations', label: `Variations (${variationCount})` },
        ].map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: tab === id ? `2px solid ${C.gold}` : '2px solid transparent',
              color: tab === id ? C.gold : C.textMuted,
              fontSize: 14,
              fontWeight: tab === id ? 600 : 400,
              padding: '8px 16px',
              cursor: 'pointer',
              marginBottom: -1,
              transition: 'color 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'ingredients' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(result.ingredients || []).map((item, i) => (
            <IngredientCard key={i} item={item} />
          ))}
        </div>
      )}

      {tab === 'variations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {variationCount === 0 ? (
            <p style={{ color: C.textMuted, fontSize: 14 }}>No variations suggested.</p>
          ) : (
            (result.variations || []).map((v, i) => <VariationCard key={i} variation={v} />)
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL)
  const [sheetUrlInput, setSheetUrlInput] = useState(DEFAULT_SHEET_URL)
  const [inventory, setInventory] = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [inventoryError, setInventoryError] = useState(null)

  const [mode, setMode] = useState('photo')

  const [recipePhoto, setRecipePhoto] = useState(null)
  const [cocktailName, setCocktailName] = useState('')
  const [menuPhoto, setMenuPhoto] = useState(null)
  const [menuCocktailName, setMenuCocktailName] = useState('')

  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const loadInventory = useCallback(async (url) => {
    setInventoryLoading(true)
    setInventoryError(null)
    setInventory(null)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      setInventory(parseInventory(text))
    } catch (err) {
      setInventoryError(err.message)
    } finally {
      setInventoryLoading(false)
    }
  }, [])

  useEffect(() => { loadInventory(sheetUrl) }, [sheetUrl, loadInventory])

  const handleReload = () => {
    if (sheetUrlInput === sheetUrl) {
      loadInventory(sheetUrlInput)
    } else {
      setSheetUrl(sheetUrlInput)
    }
  }

  const inStockCount = inventory ? inventory.filter((i) => !i.oos).length : 0
  const oosCount = inventory ? inventory.filter((i) => i.oos).length : 0

  const canAnalyze = () => {
    if (!inventory || inventoryLoading || loading) return false
    if (mode === 'photo') return !!recipePhoto
    if (mode === 'name') return cocktailName.trim().length > 0
    if (mode === 'menu') return !!menuPhoto && menuCocktailName.trim().length > 0
    return false
  }

  const handleAnalyze = async () => {
    if (!canAnalyze()) return
    setLoading(true)
    setError(null)
    setResult(null)
    setLoadingMsg({ photo: 'Analyzing recipe…', name: 'Looking up cocktail…', menu: 'Reading menu…' }[mode])

    try {
      const inventoryText = inventoryToText(inventory)
      let data
      if (mode === 'photo') data = await analyzeRecipePhoto(recipePhoto, inventoryText)
      else if (mode === 'name') data = await analyzeCocktailName(cocktailName.trim(), inventoryText)
      else data = await analyzeBarMenu(menuPhoto, menuCocktailName.trim(), inventoryText)
      const EXCLUDE_FROM_INVENTORY = [
        "orange peel", "lemon twist", "lemon peel", "lime wheel", "lime wedge",
        "citrus peel", "citrus garnish", "mint", "fresh herbs", "rosemary",
        "sugar", "salt", "cream", "milk", "egg", "eggs", "soda water", "tonic water"
      ]
      if (Array.isArray(data.ingredients)) {
        data.ingredients = data.ingredients.filter(item =>
          !EXCLUDE_FROM_INVENTORY.some(term =>
            item.ingredient.toLowerCase().includes(term)
          )
        )
      }
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const changeMode = (m) => {
    setMode(m)
    setResult(null)
    setError(null)
  }

  const MODES = [
    { id: 'photo', label: '📷 Recipe Photo' },
    { id: 'name', label: '⌨️ Cocktail Name' },
    { id: 'menu', label: '🍹 Bar Menu' },
  ]

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 20px 80px' }}>

      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '28px 0 22px',
        borderBottom: `1px solid ${C.border}`,
        marginBottom: 22,
        flexWrap: 'wrap',
        gap: 14,
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.04em', color: C.gold }}>
            Bar Cart
          </div>
          <div style={{ fontSize: 13, color: C.textFaint, marginTop: 2 }}>
            home cocktail assistant
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {inventoryLoading && (
            <span style={{ fontSize: 13, color: C.textFaint }}>Loading inventory…</span>
          )}
          {!inventoryLoading && inventory && (
            <>
              <Badge color={C.green}>{inStockCount} in stock</Badge>
              {oosCount > 0 && <Badge color={C.amber}>{oosCount} OOS</Badge>}
            </>
          )}
          {inventoryError && <Badge color={C.red}>Inventory error</Badge>}
        </div>
      </div>

      {/* Inventory URL row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <input
          type="text"
          value={sheetUrlInput}
          onChange={(e) => setSheetUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleReload()}
          placeholder="Google Sheet CSV URL"
          style={{
            flex: 1,
            minWidth: 0,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.text,
            padding: '8px 12px',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          onClick={handleReload}
          disabled={inventoryLoading}
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: inventoryLoading ? C.textFaint : C.text,
            padding: '8px 14px',
            fontSize: 13,
            cursor: inventoryLoading ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {inventoryLoading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {inventoryError && (
        <div style={{
          background: C.red + '15',
          border: `1px solid ${C.red}44`,
          borderRadius: 8,
          padding: '10px 14px',
          fontSize: 13,
          color: C.red,
          marginBottom: 20,
        }}>
          Failed to load inventory: {inventoryError}
        </div>
      )}

      {/* Mode tabs */}
      <div style={{
        display: 'flex',
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: 4,
        gap: 4,
        marginBottom: 20,
      }}>
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => changeMode(id)}
            style={{
              flex: 1,
              background: mode === id ? C.gold : 'transparent',
              border: 'none',
              borderRadius: 7,
              color: mode === id ? '#0f0f0f' : C.textMuted,
              fontWeight: mode === id ? 700 : 400,
              fontSize: 13,
              padding: '9px 6px',
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Mode content */}
      <div style={{ marginBottom: 16 }}>
        {mode === 'photo' && (
          <UploadZone
            file={recipePhoto}
            onFile={setRecipePhoto}
            onRemove={() => setRecipePhoto(null)}
          />
        )}

        {mode === 'name' && (
          <input
            type="text"
            value={cocktailName}
            onChange={(e) => setCocktailName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canAnalyze() && handleAnalyze()}
            placeholder="e.g. Naked and Famous"
            autoFocus
            style={{
              width: '100%',
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              color: C.text,
              padding: '14px 16px',
              fontSize: 16,
              outline: 'none',
            }}
          />
        )}

        {mode === 'menu' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <UploadZone
              file={menuPhoto}
              onFile={setMenuPhoto}
              onRemove={() => { setMenuPhoto(null); setMenuCocktailName('') }}
            />
            {menuPhoto && (
              <input
                type="text"
                value={menuCocktailName}
                onChange={(e) => setMenuCocktailName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canAnalyze() && handleAnalyze()}
                placeholder="Which cocktail do you want to replicate?"
                autoFocus
                style={{
                  width: '100%',
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  color: C.text,
                  padding: '12px 14px',
                  fontSize: 15,
                  outline: 'none',
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Analyze button */}
      <button
        onClick={handleAnalyze}
        disabled={!canAnalyze()}
        style={{
          width: '100%',
          background: canAnalyze() ? C.gold : C.surface,
          border: `1px solid ${canAnalyze() ? C.gold : C.border}`,
          borderRadius: 10,
          color: canAnalyze() ? '#0f0f0f' : C.textFaint,
          fontWeight: 700,
          fontSize: 15,
          padding: '13px',
          cursor: canAnalyze() ? 'pointer' : 'default',
          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
        }}
      >
        {loading ? loadingMsg : 'Analyze'}
      </button>

      {/* Error */}
      {error && (
        <div style={{
          background: C.red + '15',
          border: `1px solid ${C.red}44`,
          borderRadius: 8,
          padding: '10px 14px',
          fontSize: 13,
          color: C.red,
          marginTop: 16,
        }}>
          {error}
        </div>
      )}

      {/* Loading spinner */}
      {loading && (
        <div style={{
          textAlign: 'center',
          color: C.textMuted,
          fontSize: 14,
          marginTop: 32,
          padding: '24px 0',
        }}>
          <style>{`@keyframes bcspin { to { transform: rotate(360deg); } }`}</style>
          <div style={{
            display: 'inline-block',
            width: 30,
            height: 30,
            border: `3px solid ${C.border}`,
            borderTopColor: C.gold,
            borderRadius: '50%',
            animation: 'bcspin 0.75s linear infinite',
            marginBottom: 12,
          }} />
          <div>{loadingMsg}</div>
        </div>
      )}

      {/* Results */}
      {result && !loading && <Results result={result} />}
    </div>
  )
}
