// SUPABASE MIGRATION REQUIRED (run in Supabase SQL editor):
// create table if not exists explorations_history (
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid references auth.users not null,
//   search_key text not null,
//   primary_ingredients text[] not null default '{}',
//   cocktail_style text not null,
//   flavor_profile text[] not null default '{}',
//   low_abv boolean not null default false,
//   result jsonb not null,
//   updated_at timestamptz default now(),
//   unique(user_id, search_key)
// );
// alter table explorations_history enable row level security;
// create policy "Users own their explorations history" on explorations_history for all using (auth.uid() = user_id);
//
// alter table favorites add column if not exists source text default 'manual';
// alter table favorites add column if not exists origin_flag text;
// alter table favorites add column if not exists difficulty text;
// alter table favorites add column if not exists status text default 'favorite';
// alter table favorites add column if not exists primary_ingredients jsonb default '[]';
//
// alter table to_make add column if not exists source text default 'manual';
// alter table to_make add column if not exists origin_flag text;
// alter table to_make add column if not exists difficulty text;
// alter table to_make add column if not exists status text default 'ondeck';
// alter table to_make add column if not exists primary_ingredients jsonb default '[]';
//
// create table if not exists in_the_lab (
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid references auth.users not null,
//   recipe_name text not null,
//   summary text,
//   recipe jsonb default '[]',
//   instructions text,
//   ingredients jsonb default '[]',
//   variations jsonb default '[]',
//   notes text,
//   glass_type text,
//   mode text,
//   source text default 'Exploration',
//   origin_flag text,
//   difficulty text,
//   status text default 'inthelab',
//   tried boolean default false,
//   primary_ingredients jsonb default '[]',
//   saved_at timestamptz default now(),
//   unique(user_id, recipe_name)
// );
// alter table in_the_lab enable row level security;
// create policy "Users own their lab" on in_the_lab for all using (auth.uid() = user_id);
// alter table in_the_lab add column if not exists original_recipe jsonb;
// alter table in_the_lab add column if not exists original_instructions text;
// alter table in_the_lab add column if not exists original_summary text;
// alter table in_the_lab add column if not exists original_glass_type text;

import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'
import { supabase } from './supabase.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSWHwzLTItnOhFiPSAPObW6iJI1OVnpqiYgoaUzM_KYlzM2MgJsr4zFLpnaY_mB6kOVQLp6edO9xMIB/pub?gid=709003368&single=true&output=csv'

const MODEL = 'claude-sonnet-4-5'
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

function stripCiteTags(val) {
  if (typeof val === 'string') return val.replace(/<cite[^>]*>(.*?)<\/cite>/gs, '$1')
  if (Array.isArray(val)) return val.map(stripCiteTags)
  if (val && typeof val === 'object') {
    const out = {}
    for (const k of Object.keys(val)) out[k] = stripCiteTags(val[k])
    return out
  }
  return val
}

function extractJSON(text) {
  const t = text.trim()
  try { return JSON.parse(t) } catch (_) { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) try { return JSON.parse(fenced[1]) } catch (_) { /* fall through */ }
  const obj = t.match(/\{[\s\S]*\}/)
  if (obj) try { return JSON.parse(obj[0]) } catch (_) { /* fall through */ }
  throw new Error('Could not parse JSON from Claude response')
}

async function callClaudeText(body) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 429) throw new Error('Too many requests — wait a moment and try again.')
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  const textBlock = (data.content || []).filter((b) => b.type === 'text').pop()
  return textBlock?.text?.trim() || ''
}

async function callClaude(body) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 429) throw new Error('Too many requests — wait a moment and try again.')
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

function compressImage(base64string) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const MAX = 1024
      let { width, height } = img
      if (width > MAX || height > MAX) {
        if (width >= height) {
          height = Math.round((height * MAX) / width)
          width = MAX
        } else {
          width = Math.round((width * MAX) / height)
          height = MAX
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
    }
    img.src = `data:image/jpeg;base64,${base64string}`
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

For shelf warnings, always calculate and state the specific expiration date, not a duration. Use wording that depends on whether the date is in the past or future relative to today:
- If the expiration date is still in the future: "Opened 3/20/2026 — best by approximately 4/20/2026"
- If the expiration date has already passed: "Opened 1/1/2026 — expired approximately 2/1/2026, consider replacing"
Never use the word "expired" when the date is still in the future. Never say "still good for X months" — always give the actual date.

Common fresh garnishes (orange peel, lemon twist, lime wheel, citrus peels, fresh herbs) and pantry staples (sugar, salt, cream, milk, eggs, soda water) should appear in the recipe array with their amounts as normal, but must be excluded from the ingredients array entirely. Do not check them against inventory.

Return ONLY valid JSON with no markdown fences, no extra text. Use this exact structure:
{
  "recipe_name": "string",
  "glass_type": "coupe | rocks | tiki | collins | null",
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
  const { base64: rawBase64 } = await fileToBase64(imageFile)
  const base64 = await compressImage(rawBase64)
  const mediaType = 'image/jpeg'
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

async function analyzeCocktailNameTrainingOnly(name, inventoryText) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `Look up the canonical recipe for the cocktail "${name}" using your training knowledge. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
    }],
  }
  const data = await callClaude(body)
  data._trainingDataFallback = true
  return { data, body }
}

async function parseMenuCocktails(imageFile) {
  const { base64: rawBase64 } = await fileToBase64(imageFile)
  const base64 = await compressImage(rawBase64)
  const mediaType = 'image/jpeg'
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
  const { base64: rawBase64 } = await fileToBase64(menuFile)
  const base64 = await compressImage(rawBase64)
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }]
  if (cocktailPhotoFile) {
    const { base64: rawB2 } = await fileToBase64(cocktailPhotoFile)
    const b2 = await compressImage(rawB2)
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b2 } })
    content.push({ type: 'text', text: 'The second image is a photo of the actual cocktail as served — use it to help infer ingredients, color, garnish, and glassware.' })
  }
  content.push({
    type: 'text',
    text: `The first image shows a bar menu. Find the cocktail named "${cocktailName}" in the menu. Read its description carefully and infer the most likely ingredients from it. Set "inferred": true for any ingredient you are inferring from a vague description rather than one that is explicitly listed. Then check each ingredient against the bar inventory and provide a full analysis.\n\n${sharedPromptSuffix(inventoryText)}`,
  })
  const body = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }
  return { data: await callClaude(body), body }
}

async function analyzeExplorationsRecipes(ingredients, style, flavors, lowABV, inventoryText) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender. Search the web for PUBLISHED cocktail recipes featuring the featured ingredients that match the selected style and flavor profile. Return ONLY real recipes found from published sources — do NOT invent original cocktails. Set origin_flag: "from_recipe" for ALL suggestions.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}
COCKTAIL STYLE: ${style}
FLAVOR PREFERENCES: ${flavors.length > 0 ? flavors.join(', ') : 'No specific preference'}
LOW ALCOHOL: ${lowABV ? 'Yes — prioritize lower ABV options' : 'No preference'}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

First check if the featured ingredients fundamentally clash in cocktail contexts. If so, set "incompatible": true and explain briefly in a friendly tone.

Otherwise use web search to find 2–3 published cocktail recipes. For each, check all non-garnish, non-pantry-staple ingredients against the inventory. Set can_make_now: true only if all required spirits and liqueurs are available. Common fresh garnishes (citrus peels, mint, herbs) and pantry staples (sugar, salt, cream, eggs, soda water) must never appear in missing_ingredients.

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin_flag, difficulty, difficulty_note, can_make_now, missing_ingredients, summary, recipe (array of {ingredient, amount}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

Return ONLY valid JSON with no markdown fences:
{
  "incompatible": false,
  "incompatibility_reason": null,
  "flavor_profile_note": "1-2 sentences on why these ingredients work together",
  "pairs_well_with": "2-3 strongest flavor affinities only — one short sentence, not an exhaustive list",
  "suggestions": [
    {
      "recipe_name": "string",
      "origin_flag": "from_recipe",
      "difficulty": "easy | medium | hard",
      "difficulty_note": "One sentence explaining difficulty",
      "can_make_now": true,
      "missing_ingredients": [],
      "summary": "1-2 sentence description",
      "recipe": [{ "ingredient": "string", "amount": "string" }],
      "instructions": "string",
      "glass_type": "coupe | rocks | tiki | collins | null",
      "ingredients": [
        {
          "ingredient": "string",
          "status": "found | substitute | missing",
          "location": "string or null",
          "substitute": "string or null",
          "substitute_location": "string or null",
          "flavor_impact": "string or null"
        }
      ],
      "technique_notes": "string or null"
    }
  ]
}`,
    }],
  }
  const firstText = await callClaudeText(body)
  try {
    return extractJSON(firstText)
  } catch (_) {
    const retryText = await callClaudeText({
      model: MODEL,
      max_tokens: 3000,
      messages: [
        body.messages[0],
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'Your previous response was cut off or invalid JSON. Please return ONLY the complete valid JSON object, no other text.' },
      ],
    })
    return extractJSON(retryText)
  }
}

async function analyzeExplorationsOriginals(ingredients, style, flavors, lowABV, inventoryText) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender inventing ORIGINAL creative cocktails. Do NOT look up or reference published recipes — these should be entirely your own creative inventions. Set origin_flag: "original" for ALL suggestions. Think like a creative craft bartender — suggest infusions, custom syrups, acid adjustments, fat washing, clarifications, or carbonation where genuinely appropriate.

The primary ingredient(s) for this exploration are: ${ingredients.join(', ')}. Use these exact names when referencing them in your response.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}
COCKTAIL STYLE: ${style}
FLAVOR PREFERENCES: ${flavors.length > 0 ? flavors.join(', ') : 'No specific preference'}
LOW ALCOHOL: ${lowABV ? 'Yes — prioritize lower ABV options' : 'No preference'}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

First check if the featured ingredients fundamentally clash in cocktail contexts. If so, set "incompatible": true and explain briefly in a friendly tone.

Otherwise invent 2–3 original cocktails that showcase the featured ingredients. For each, check all non-garnish, non-pantry-staple ingredients against the inventory. Set can_make_now: true only if all required spirits and liqueurs are available. Common fresh garnishes (citrus peels, mint, herbs) and pantry staples (sugar, salt, cream, eggs, soda water) must never appear in missing_ingredients.

Include a mix of can_make_now: true and can_make_now: false results — at minimum, include at least 1 suggestion where can_make_now: false (something worth buying an ingredient for), unless the ingredient combination is so niche that no reasonable 'worth buying' suggestion exists.

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin_flag, difficulty, difficulty_note, can_make_now, missing_ingredients, summary, recipe (array of {ingredient, amount}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

Return ONLY valid JSON with no markdown fences:
{
  "incompatible": false,
  "incompatibility_reason": null,
  "flavor_profile_note": "1-2 sentences on why these ingredients work together",
  "pairs_well_with": "2-3 strongest flavor affinities only — one short sentence, not an exhaustive list",
  "suggestions": [
    {
      "recipe_name": "string",
      "origin_flag": "original",
      "difficulty": "easy | medium | hard",
      "difficulty_note": "One sentence explaining difficulty",
      "can_make_now": true,
      "missing_ingredients": [],
      "summary": "1-2 sentence description",
      "recipe": [{ "ingredient": "string", "amount": "string" }],
      "instructions": "string",
      "glass_type": "coupe | rocks | tiki | collins | null",
      "ingredients": [
        {
          "ingredient": "string",
          "status": "found | substitute | missing",
          "location": "string or null",
          "substitute": "string or null",
          "substitute_location": "string or null",
          "flavor_impact": "string or null"
        }
      ],
      "technique_notes": "string or null"
    }
  ]
}`,
    }],
  }
  const firstText = await callClaudeText(body)
  try {
    return extractJSON(firstText)
  } catch (_) {
    const retryText = await callClaudeText({
      model: MODEL,
      max_tokens: 3000,
      messages: [
        body.messages[0],
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'Your previous response was cut off or invalid JSON. Please return ONLY the complete valid JSON object, no other text.' },
      ],
    })
    return extractJSON(retryText)
  }
}

async function analyzeExplorations(ingredients, style, flavors, lowABV, inventoryText) {
  const slimInventoryText = inventoryText.split('\n').map((line, i) => {
    if (i === 0) return 'Spirit | Category | Status | Notes'
    const parts = line.split(' | ')
    const notes = (parts[6] || '').trim()
    return `${parts[0] || ''} | ${parts[3] || ''} | ${parts[5] || ''}${notes ? ` | ${notes}` : ''}`
  }).join('\n')

  console.log('Slim inventory sample:', slimInventoryText.substring(0, 500))

  const [recipesSettled, originalsSettled] = await Promise.allSettled([
    analyzeExplorationsRecipes(ingredients, style, flavors, lowABV, inventoryText),
    analyzeExplorationsOriginals(ingredients, style, flavors, lowABV, slimInventoryText),
  ])

  console.log('Web call result:', recipesSettled.status, recipesSettled.reason || 'ok')
  console.log('Originals call result:', originalsSettled.status, originalsSettled.reason || 'ok')

  const recipeData = recipesSettled.status === 'fulfilled' ? recipesSettled.value : null
  const originalData = originalsSettled.status === 'fulfilled' ? originalsSettled.value : null

  if (!recipeData && !originalData) {
    throw new Error('Could not generate suggestions. Please try again.')
  }

  const partialSource = !recipeData ? 'web' : !originalData ? 'original' : null
  const allSuggestions = [...(recipeData?.suggestions || []), ...(originalData?.suggestions || [])]
  const primaryData = recipeData || originalData

  if (allSuggestions.length === 0) {
    return {
      result: stripCiteTags({
        incompatible: true,
        incompatibility_reason: primaryData.incompatibility_reason,
        flavor_profile_note: null,
        pairs_well_with: null,
        suggestions: [],
      }),
      partialSource,
    }
  }

  return {
    result: stripCiteTags({
      incompatible: false,
      incompatibility_reason: null,
      flavor_profile_note: recipeData?.flavor_profile_note || originalData?.flavor_profile_note || null,
      pairs_well_with: recipeData?.pairs_well_with || originalData?.pairs_well_with || null,
      suggestions: allSuggestions,
    }),
    partialSource,
  }
}

async function refineExplorations(ingredients, style, flavors, lowABV, inventoryText, previousNames, feedbackText) {
  const body = {
    model: MODEL,
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender helping someone explore cocktail possibilities.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}
COCKTAIL STYLE: ${style}
FLAVOR PREFERENCES: ${flavors.length > 0 ? flavors.join(', ') : 'No specific preference'}
LOW ALCOHOL: ${lowABV ? 'Yes — prioritize lower ABV options' : 'No preference'}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

Previous suggestions shown to the user: ${previousNames.join(', ')}

The user provided feedback on the previous suggestions: "${feedbackText}". Based on this feedback, return a revised set of suggestions. If the feedback asks for 'more' or 'additional' results, include new suggestions not previously shown. If the feedback asks for something 'different' or describes a change to a specific recipe, revise accordingly. Return the same JSON structure as before, including updated flavor_profile_note and pairs_well_with if relevant.

Include a mix of can_make_now: true and can_make_now: false results — at minimum, include at least 1 suggestion where can_make_now: false, unless the ingredient combination is so niche that no reasonable 'worth buying' suggestion exists. Return no more than 4 suggestions total.

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin_flag, difficulty, difficulty_note, can_make_now, missing_ingredients, summary, recipe (array of {ingredient, amount}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

Return ONLY valid JSON with no markdown fences:
{
  "incompatible": false,
  "incompatibility_reason": null,
  "flavor_profile_note": "1-2 sentences on why these ingredients work together",
  "pairs_well_with": "2-3 strongest flavor affinities only — one short sentence, not an exhaustive list",
  "suggestions": [
    {
      "recipe_name": "string",
      "origin_flag": "from_recipe | original",
      "difficulty": "easy | medium | hard",
      "difficulty_note": "One sentence explaining difficulty",
      "can_make_now": true,
      "missing_ingredients": [],
      "summary": "1-2 sentence description",
      "recipe": [{ "ingredient": "string", "amount": "string" }],
      "instructions": "string",
      "glass_type": "coupe | rocks | tiki | collins | null",
      "ingredients": [
        {
          "ingredient": "string",
          "status": "found | substitute | missing",
          "location": "string or null",
          "substitute": "string or null",
          "substitute_location": "string or null",
          "flavor_impact": "string or null"
        }
      ],
      "technique_notes": "string or null"
    }
  ]
}`,
    }],
  }
  const firstText = await callClaudeText(body)
  try {
    return extractJSON(firstText)
  } catch (_) {
    const retryText = await callClaudeText({
      model: MODEL,
      max_tokens: 6000,
      messages: [
        body.messages[0],
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'Your previous response was cut off or invalid JSON. Please return ONLY the complete valid JSON object, no other text.' },
      ],
    })
    try {
      return extractJSON(retryText)
    } catch (_) {
      throw new Error('Could not generate valid suggestions. Please try again.')
    }
  }
}

async function tweakSingleSuggestion(suggestion, feedbackText) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender. The user wants this specific cocktail suggestion adjusted.

Current suggestion:
${JSON.stringify(suggestion, null, 2)}

The user's feedback: "${feedbackText}"

Return a revised version of just this one suggestion in the same JSON structure as a single suggestion object. Return ONLY valid JSON with no markdown fences — a single object, not an array.`,
    }],
  }
  const firstText = await callClaudeText(body)
  try {
    return extractJSON(firstText)
  } catch (_) {
    const retryText = await callClaudeText({
      model: MODEL,
      max_tokens: 1500,
      messages: [
        body.messages[0],
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'Your previous response was cut off or invalid JSON. Please return ONLY the complete valid JSON object for the single suggestion, no other text.' },
      ],
    })
    return extractJSON(retryText)
  }
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

function GlassIcon({ type }) {
  if (!type) return null
  const base = { xmlns: 'http://www.w3.org/2000/svg', width: '24', height: '32', viewBox: '0 0 24 32', style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 } }
  if (type === 'coupe') return (
    <svg {...base}>
      {/* Bowl: wide curved triangle */}
      <path d="M2 2 L12 20 L22 2 Z" fill="#c9a84c" />
      {/* Stem */}
      <rect x="11" y="20" width="2" height="7" fill="#c9a84c" />
      {/* Base */}
      <rect x="7" y="27" width="10" height="3" rx="1" fill="#c9a84c" />
    </svg>
  )
  if (type === 'rocks') return (
    <svg {...base}>
      {/* Short wide trapezoid, slightly wider at top */}
      <path d="M2 8 L4 28 L20 28 L22 8 Z" fill="#c9a84c" />
    </svg>
  )
  if (type === 'tiki') return (
    <svg {...base}>
      {/* Barrel body, wider in middle */}
      <path d="M7 2 Q4 10 4 16 Q4 24 7 30 L17 30 Q20 24 20 16 Q20 10 17 2 Z" fill="#c9a84c" />
      {/* Handle bump on right */}
      <path d="M20 13 Q25 14 25 18 Q25 22 20 22 Z" fill="#c9a84c" />
    </svg>
  )
  if (type === 'collins') return (
    <svg {...base}>
      {/* Tall narrow rectangle */}
      <rect x="7" y="2" width="10" height="28" rx="1" fill="#c9a84c" />
    </svg>
  )
  return null
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

// ─── Ingredient Drawer ────────────────────────────────────────────────────────

function IngredientDrawer({ item, flavorProfile, loading, onClose, inventory }) {
  const invMatch = inventory?.find(inv =>
    inv.spirit.toLowerCase() === item.ingredient.toLowerCase() ||
    item.ingredient.toLowerCase().includes(inv.spirit.toLowerCase()) ||
    inv.spirit.toLowerCase().includes(item.ingredient.toLowerCase())
  )

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 99, transition: 'opacity 0.25s' }} />
      {/* Drawer */}
      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 700, background: '#1c1c1c', borderTop: `1px solid ${C.border}`, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '20px 20px 36px', zIndex: 100, maxHeight: '72vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>{item.ingredient}</div>
            {(invMatch?.category || item.location) && (
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {invMatch?.category && <span>{invMatch.category}</span>}
                {item.location && <span>📍 {item.location}</span>}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, fontSize: 20, lineHeight: 1, padding: '2px 9px', cursor: 'pointer', flexShrink: 0 }}>×</button>
        </div>

        {/* Flavor profile */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Flavor Profile</div>
          {loading
            ? <div style={{ color: C.textMuted, fontSize: 14 }}>Loading…</div>
            : <p style={{ fontSize: 14, color: C.text, lineHeight: 1.65, margin: 0 }}>{flavorProfile || '—'}</p>
          }
        </div>

        {item.shelf_warning && (
          <div style={{ fontSize: 13, color: C.amber, background: C.amber + '12', border: `1px solid ${C.amber}33`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            ⚠️ {item.shelf_warning}
          </div>
        )}
        {item.refrigerate_tip && (
          <div style={{ fontSize: 13, color: C.blue, background: C.blue + '12', border: `1px solid ${C.blue}33`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            ❄️ {item.refrigerate_tip}
          </div>
        )}
        {invMatch?.notes && (
          <div style={{ fontSize: 13, color: C.textFaint, marginTop: 6 }}>{invMatch.notes}</div>
        )}
      </div>
    </>
  )
}

// ─── Ingredient Card ──────────────────────────────────────────────────────────

function IngredientCard({ item, shoppingList, onAddToList, onOpenDrawer }) {
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
            <span onClick={() => onOpenDrawer(item)} style={{ fontWeight: 600, fontSize: 15, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{item.ingredient}</span>
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

// ─── Badge helpers ────────────────────────────────────────────────────────────

function OriginBadge({ originFlag }) {
  if (!originFlag) return null
  return (
    <span style={{ fontSize: 11, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 7px', color: C.textMuted }}>
      {originFlag === 'from_recipe' ? '📖 From a recipe' : '✨ Original'}
    </span>
  )
}

function DifficultyBadge({ difficulty }) {
  if (!difficulty) return null
  const color = difficulty === 'easy' ? C.green : difficulty === 'medium' ? C.amber : C.red
  const emoji = difficulty === 'easy' ? '🟢' : difficulty === 'medium' ? '🟡' : '🔴'
  const label = difficulty.charAt(0).toUpperCase() + difficulty.slice(1)
  return (
    <span style={{ fontSize: 11, color, background: color + '15', border: `1px solid ${color}33`, borderRadius: 4, padding: '2px 7px' }}>
      {emoji} {label}
    </span>
  )
}

// ─── Results ──────────────────────────────────────────────────────────────────

function Results({ result, adjustmentNote, shoppingList, onAddToList, favorites, onToggleFavorite, toMake, onToggleToMake, inTheLabList, onToggleInTheLab, onFeedback, feedbackLoading, inventory, isInLab, labItem, onMarkTried, onSaveLabToFavorites, onUpdateLabNotes, onArchiveFromLab, onRevertLabTweak }) {
  const [tab, setTab] = useState('ingredients')
  const [feedbackText, setFeedbackText] = useState('')
  const adjustmentNoteRef = useRef(null)
  const [drawerItem, setDrawerItem] = useState(null)
  const [flavorCache, setFlavorCache] = useState({})
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [revertedBanner, setRevertedBanner] = useState(false)

  useEffect(() => {
    if (adjustmentNote) {
      adjustmentNoteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [adjustmentNote])

  const openDrawer = async (item) => {
    setDrawerItem(item)
    if (flavorCache[item.ingredient] !== undefined) return
    setDrawerLoading(true)
    try {
      const text = await callClaudeText({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Describe ${item.ingredient} briefly for a cocktail enthusiast: its flavor profile, common cocktail uses, and what cocktail families or drink styles it belongs to. 2-3 sentences max.`,
        }],
      })
      setFlavorCache(prev => ({ ...prev, [item.ingredient]: text }))
    } catch (_) {
      setFlavorCache(prev => ({ ...prev, [item.ingredient]: 'Could not load flavor profile.' }))
    } finally {
      setDrawerLoading(false)
    }
  }
  const ingredientCount = result.ingredients?.length || 0
  const variationCount = result.variations?.length || 0
  const isFav = favorites.some(f => f.recipeName === result.recipe_name)
  const isToMake = toMake.some(f => f.recipeName === result.recipe_name)
  const isInLabSaved = (inTheLabList || []).some(f => f.recipeName === result.recipe_name)

  const handleFeedbackSubmit = () => {
    if (!feedbackText.trim()) return
    onFeedback(feedbackText.trim())
    setFeedbackText('')
  }

  return (
    <div style={{ marginTop: 36, opacity: feedbackLoading ? 0.5 : 1, transition: 'opacity 0.3s', pointerEvents: feedbackLoading ? 'none' : 'auto' }}>
      {/* Name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, color: C.gold, letterSpacing: '-0.03em', lineHeight: 1.2, margin: 0 }}>
          {result.recipe_name}
        </h2>
        {result.glass_type && <GlassIcon type={result.glass_type} size={22} />}
      </div>
      {/* Action buttons */}
      {isInLab && labItem ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button
              onClick={() => onMarkTried(labItem.id, !labItem.tried)}
              style={{ background: labItem.tried ? C.green + '22' : 'none', border: `1px solid ${labItem.tried ? C.green : C.border}`, borderRadius: 20, color: labItem.tried ? C.green : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
              {labItem.tried ? '✓ Tried' : '✓ Mark as Tried'}
            </button>
            <button
              onClick={() => onSaveLabToFavorites(labItem)}
              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              → Save to Favorites
            </button>
            <button
              onClick={() => onArchiveFromLab(labItem.id)}
              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              🗑 Archive
            </button>
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 6 }}>Your notes</div>
            <textarea
              key={labItem.id}
              defaultValue={labItem.note || ''}
              onBlur={(e) => onUpdateLabNotes(labItem.id, e.target.value)}
              placeholder="How did it go? What would you change?"
              style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, padding: '10px 12px', resize: 'vertical', minHeight: 72, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button
            onClick={() => { console.log('On Deck clicked', result); onToggleToMake(result) }}
            style={{ background: 'none', border: `1px solid ${isToMake ? C.blue : C.border}`, borderRadius: 20, color: isToMake ? C.blue : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s' }}
          >
            {isToMake ? '🍹 Saved to On Deck' : '🍹 On Deck'}
          </button>
          <button
            onClick={() => onToggleInTheLab(result)}
            style={{ background: 'none', border: `1px solid ${isInLabSaved ? C.amber : C.border}`, borderRadius: 20, color: isInLabSaved ? C.amber : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s' }}
          >
            {isInLabSaved ? '🧪 In the Lab ✓' : '🧪 In the Lab'}
          </button>
          <button
            onClick={() => onToggleFavorite(result)}
            style={{ background: 'none', border: `1px solid ${isFav ? C.gold : C.border}`, borderRadius: 20, color: isFav ? C.gold : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s' }}
          >
            {isFav ? '♥ Saved' : '♡ Save to Favorites'}
          </button>
        </div>
      )}

      {result.summary && (
        <p style={{ color: C.textMuted, fontSize: 15, marginBottom: result._trainingDataFallback ? 10 : 24, lineHeight: 1.65, maxWidth: 600 }}>
          {result.summary}
        </p>
      )}
      {result._trainingDataFallback && (
        <p style={{ fontSize: 12, color: C.textFaint, marginBottom: 20 }}>Recipe sourced from training data — web search unavailable.</p>
      )}

      {/* Adjustment note */}
      {revertedBanner ? (
        <div ref={adjustmentNoteRef} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14, color: C.textMuted }}>
          ↩ Reverted to original
        </div>
      ) : adjustmentNote && (
        <div ref={adjustmentNoteRef} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: C.gold + '18', border: `1px solid ${C.gold}44`, borderRadius: 10, padding: '12px 16px', marginBottom: isInLab && labItem?.originalRecipe ? 6 : 20 }}>
          <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>✓</span>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.gold }}>Adjusted </span>
            <span style={{ fontSize: 14, color: C.text }}>{adjustmentNote}</span>
          </div>
        </div>
      )}
      {!revertedBanner && isInLab && labItem?.originalRecipe && (
        <div style={{ marginBottom: 20 }}>
          <button
            onClick={() => {
              onRevertLabTweak(labItem)
              setRevertedBanner(true)
              setTimeout(() => setRevertedBanner(false), 3000)
            }}
            style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
            ↩ Revert to original
          </button>
        </div>
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
            <IngredientCard key={i} item={item} shoppingList={shoppingList} onAddToList={onAddToList} onOpenDrawer={openDrawer} />
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

      {/* Ingredient drawer */}
      {drawerItem && (
        <IngredientDrawer
          item={drawerItem}
          flavorProfile={flavorCache[drawerItem.ingredient]}
          loading={drawerLoading && flavorCache[drawerItem.ingredient] === undefined}
          onClose={() => setDrawerItem(null)}
          inventory={inventory}
        />
      )}

      {/* Feedback */}
      <div style={{ marginTop: 32, paddingTop: 24, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 13, color: C.textFaint, marginBottom: 10 }}>
          {feedbackLoading ? 'Revising based on your feedback…' : 'Something off? Describe what to adjust:'}
        </div>
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
            style={{ background: feedbackText.trim() && !feedbackLoading ? C.gold : C.surface, border: `1px solid ${feedbackText.trim() && !feedbackLoading ? C.gold : C.border}`, borderRadius: 8, color: feedbackText.trim() && !feedbackLoading ? '#0f0f0f' : C.textFaint, fontSize: 13, fontWeight: 600, padding: '9px 14px', cursor: feedbackText.trim() && !feedbackLoading ? 'pointer' : 'default', whiteSpace: 'nowrap', transition: 'background 0.15s, color 0.15s', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {feedbackLoading && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'bcspini 0.6s linear infinite', flexShrink: 0 }} />}
            {feedbackLoading ? 'Revising…' : isInLab ? 'Tweak & Improve' : 'Something Off? Adjust'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function SettingsScreen({ sheetUrlInput, setSheetUrlInput, onReload, inventoryLoading, inventoryError, inventory, inStockCount, oosCount }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 12 }}>Spreadsheet</div>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>Google Sheet published as CSV</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <input
          type="text"
          value={sheetUrlInput}
          onChange={(e) => setSheetUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onReload()}
          placeholder="Google Sheet CSV URL"
          style={{ flex: 1, minWidth: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '9px 12px', fontSize: 13, outline: 'none' }}
        />
        <button
          onClick={onReload}
          disabled={inventoryLoading}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: inventoryLoading ? C.textFaint : C.text, padding: '9px 14px', fontSize: 13, cursor: inventoryLoading ? 'default' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {inventoryLoading ? 'Loading…' : 'Reload'}
        </button>
      </div>
      {inventoryLoading && <div style={{ fontSize: 13, color: C.textFaint }}>Loading inventory…</div>}
      {inventoryError && (
        <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.red }}>
          Failed to load inventory: {inventoryError}
        </div>
      )}
      {!inventoryLoading && !inventoryError && inventory && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{inStockCount} in stock</span>
          {oosCount > 0 && <span style={{ fontSize: 13, background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{oosCount} OOS</span>}
        </div>
      )}
    </div>
  )
}

// ─── Inventory Screen ─────────────────────────────────────────────────────────

function calcExpiry(item) {
  if (!item.dateOpened || item.dateOpened === 'N/A') return null
  const parts = item.dateOpened.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!parts) return null
  const opened = new Date(+parts[3], +parts[1] - 1, +parts[2])
  if (isNaN(opened)) return null
  const cat = (item.category || '').toLowerCase()
  let months = null
  if (cat.includes('vermouth')) months = 3
  else if (cat.includes('syrup')) months = 1
  else if (cat.includes('amaro')) months = 9
  else if (cat.includes('liqueur') || cat.includes('liquor') || cat.includes('bitters')) months = 6
  if (months === null) return null
  const expiry = new Date(opened)
  expiry.setMonth(expiry.getMonth() + months)
  return expiry
}

function InventoryScreen({ inventory, inStockCount, oosCount }) {
  const [selectedCats, setSelectedCats] = useState(new Set())

  if (!inventory) return <p style={{ color: C.textMuted, fontSize: 14 }}>Inventory not loaded.</p>

  const now = new Date(); now.setHours(0, 0, 0, 0)
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30)

  const categories = Array.from(new Set(inventory.map(i => i.category).filter(Boolean))).sort()
  const anySelected = selectedCats.size > 0
  const filtered = anySelected ? inventory.filter(i => selectedCats.has(i.category)) : inventory

  const toggleCat = (cat) => {
    setSelectedCats(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const groups = {}
  for (const item of filtered) {
    const loc = item.location || 'Unknown'
    if (!groups[loc]) groups[loc] = []
    groups[loc].push(item)
  }
  const sortedLocs = Object.keys(groups).sort()

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{inStockCount} in stock</span>
        {oosCount > 0 && <span style={{ fontSize: 13, background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{oosCount} OOS</span>}
      </div>

      {/* Category filter pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <button onClick={() => setSelectedCats(new Set())} style={{ background: !anySelected ? C.gold + '22' : C.surface, border: `1px solid ${!anySelected ? C.gold + '55' : C.border}`, borderRadius: 20, color: !anySelected ? C.gold : C.textMuted, fontSize: 12, fontWeight: !anySelected ? 600 : 400, padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, transition: 'background 0.15s, color 0.15s' }}>
          All
          <span style={{ fontSize: 10, fontWeight: 700, background: (!anySelected ? C.gold : C.textFaint) + '33', color: !anySelected ? C.gold : C.textFaint, borderRadius: 8, padding: '1px 5px' }}>{inventory.length}</span>
        </button>
        {categories.map(cat => {
          const active = selectedCats.has(cat)
          const count = inventory.filter(i => i.category === cat).length
          return (
            <button key={cat} onClick={() => toggleCat(cat)} style={{ background: active ? C.gold + '22' : C.surface, border: `1px solid ${active ? C.gold + '55' : C.border}`, borderRadius: 20, color: active ? C.gold : C.textMuted, fontSize: 12, fontWeight: active ? 600 : 400, padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, transition: 'background 0.15s, color 0.15s' }}>
              {cat}
              <span style={{ fontSize: 10, fontWeight: 700, background: (active ? C.gold : C.textFaint) + '33', color: active ? C.gold : C.textFaint, borderRadius: 8, padding: '1px 5px' }}>{count}</span>
            </button>
          )
        })}
      </div>

      {sortedLocs.map(loc => (
        <div key={loc} style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 10 }}>{loc}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {groups[loc].map((item, i) => {
              const expiry = calcExpiry(item)
              const isExpired = expiry && expiry < now
              const expiringSoon = expiry && !isExpired && expiry <= in30
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.surface, borderRadius: 8, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: item.oos ? C.amber : C.green, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, flex: 1, minWidth: 120 }}>{item.spirit}</span>
                  {item.subLocation && <span style={{ fontSize: 12, color: C.textMuted }}>{item.subLocation}</span>}
                  {item.category && <span style={{ fontSize: 11, color: C.textFaint, background: C.border, borderRadius: 4, padding: '2px 6px' }}>{item.category}</span>}
                  {item.oos && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>OOS</span>}
                  {isExpired && <span style={{ fontSize: 11, fontWeight: 700, color: C.red, background: C.red + '18', border: `1px solid ${C.red}44`, borderRadius: 4, padding: '2px 6px' }}>Exp {expiry.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>}
                  {expiringSoon && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber, background: C.amber + '18', border: `1px solid ${C.amber}44`, borderRadius: 4, padding: '2px 6px' }}>Exp {expiry.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>}
                </div>
              )
            })}
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

function FavoriteCard({ fav, onRemove, onView, onUpdateNote }) {
  const [editingNote, setEditingNote] = useState(false)
  const [noteText, setNoteText] = useState(fav.note || '')

  const saveNote = () => {
    onUpdateNote(fav.id, noteText.trim())
    setEditingNote(false)
  }

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.gold, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7 }}>{fav.recipeName}{fav.glassType && <GlassIcon type={fav.glassType} size={15} />}</div>
          {fav.source === 'Exploration' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <OriginBadge originFlag={fav.originFlag} />
              <DifficultyBadge difficulty={fav.difficulty} />
            </div>
          )}
          {fav.summary && <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{fav.summary}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => onView(fav)} style={{ background: C.gold, border: 'none', borderRadius: 7, color: '#0f0f0f', fontSize: 12, fontWeight: 700, padding: '6px 12px', cursor: 'pointer' }}>View</button>
          <button onClick={() => onRemove(fav.id)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textFaint, fontSize: 18, padding: '2px 8px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
      </div>

      {fav.recipe && fav.recipe.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.textFaint }}>
          {fav.recipe.slice(0, 3).map(r => r.ingredient).join(', ')}{fav.recipe.length > 3 ? ` +${fav.recipe.length - 3} more` : ''}
        </div>
      )}

      {/* Notes */}
      <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        {editingNote ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note about this recipe…"
              rows={3}
              autoFocus
              style={{ width: '100%', background: '#111', border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: '8px 10px', fontSize: 13, resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={saveNote} style={{ background: C.gold, border: 'none', borderRadius: 6, color: '#0f0f0f', fontSize: 12, fontWeight: 700, padding: '5px 12px', cursor: 'pointer' }}>Save</button>
              <button onClick={() => { setNoteText(fav.note || ''); setEditingNote(false) }} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        ) : fav.note ? (
          <p onClick={() => setEditingNote(true)} style={{ fontSize: 13, color: C.textMuted, fontStyle: 'italic', lineHeight: 1.55, cursor: 'pointer', margin: 0 }}>
            {fav.note}
          </p>
        ) : (
          <button onClick={() => setEditingNote(true)} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0 }}>
            + Add a note…
          </button>
        )}
      </div>
    </div>
  )
}

function FavoritesScreen({ favorites, onRemove, onView, onUpdateNote }) {
  if (favorites.length === 0) {
    return <p style={{ color: C.textMuted, fontSize: 14 }}>No saved favorites yet. Analyze a recipe and tap ♡ Save to Favorites.</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {favorites.map(fav => (
        <FavoriteCard key={fav.id} fav={fav} onRemove={onRemove} onView={onView} onUpdateNote={onUpdateNote} />
      ))}
    </div>
  )
}

// ─── To Make Screen ───────────────────────────────────────────────────────────

function ToMakeCard({ item, onRemove, onView }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.blue, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7 }}>{item.recipeName}{item.glassType && <GlassIcon type={item.glassType} size={15} />}</div>
          {item.source === 'Exploration' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <OriginBadge originFlag={item.originFlag} />
              <DifficultyBadge difficulty={item.difficulty} />
            </div>
          )}
          {item.summary && <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.summary}</div>}
          {item.recipe && item.recipe.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.textFaint }}>
              {item.recipe.slice(0, 3).map(r => r.ingredient).join(', ')}{item.recipe.length > 3 ? ` +${item.recipe.length - 3} more` : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => onView(item)} style={{ background: C.blue, border: 'none', borderRadius: 7, color: '#fff', fontSize: 12, fontWeight: 700, padding: '6px 12px', cursor: 'pointer' }}>View</button>
          <button onClick={() => onRemove(item.id)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textFaint, fontSize: 18, padding: '2px 8px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
      </div>
    </div>
  )
}

// ─── In the Lab Card ──────────────────────────────────────────────────────────

function InTheLabCard({ item, onRemove, onView }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.amber, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {item.recipeName}{item.glassType && <GlassIcon type={item.glassType} size={15} />}
            {item.tried && <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.green + '22', borderRadius: 10, padding: '2px 7px' }}>✓ Tried</span>}
          </div>
          {item.source === 'Exploration' && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <OriginBadge originFlag={item.originFlag} />
              <DifficultyBadge difficulty={item.difficulty} />
            </div>
          )}
          {item.summary && <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.summary}</div>}
          {item.recipe && item.recipe.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.textFaint }}>
              {item.recipe.slice(0, 3).map(r => r.ingredient).join(', ')}{item.recipe.length > 3 ? ` +${item.recipe.length - 3} more` : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => onView(item)} style={{ background: C.amber, border: 'none', borderRadius: 7, color: '#0f0f0f', fontSize: 12, fontWeight: 700, padding: '6px 12px', cursor: 'pointer' }}>View</button>
          <button onClick={() => onRemove(item.id)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textFaint, fontSize: 18, padding: '2px 8px', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
      </div>
    </div>
  )
}

// ─── Saved Screen ─────────────────────────────────────────────────────────────

const SOURCE_OPTIONS = ['All', 'Recipe Screenshot', 'Bar Menu', 'Cocktail Name', 'Exploration']

function SavedScreen({ savedSubTab, setSavedSubTab, toMake, inTheLabList, favorites, onRemoveToMake, onRemoveInTheLab, onRemoveFavorite, onViewToMake, onViewInTheLab, onViewFavorite, onUpdateNote }) {
  const [sourceFilter, setSourceFilter] = useState('All')
  const [ingredientFilter, setIngredientFilter] = useState(null)

  const labTriedCount = inTheLabList.filter(i => i.tried).length

  const SUB_TABS = [
    { id: 'ondeck',   label: 'On Deck',    count: toMake.length,        color: C.blue },
    { id: 'inthelab', label: 'In the Lab', count: inTheLabList.length, triedCount: labTriedCount, color: C.amber },
    { id: 'favorites',label: 'Favorites',  count: favorites.length,     color: C.gold },
  ]

  const currentList = savedSubTab === 'ondeck' ? toMake : savedSubTab === 'inthelab' ? inTheLabList : favorites

  let filteredList = sourceFilter === 'All' ? currentList : currentList.filter(i => (i.source || 'manual') === sourceFilter)
  if (sourceFilter === 'Exploration' && ingredientFilter) {
    filteredList = filteredList.filter(i => (i.primaryIngredients || []).includes(ingredientFilter))
  }

  const uniqueIngredients = [...new Set(
    currentList.filter(i => i.source === 'Exploration').flatMap(i => i.primaryIngredients || [])
  )]

  const emptyMsg = currentList.length === 0
    ? savedSubTab === 'ondeck' ? 'No recipes on deck yet. Analyze a recipe and tap 🍹 On Deck.'
      : savedSubTab === 'inthelab' ? 'Nothing in the lab yet. Save a recipe with 🧪 In the Lab.'
      : 'No saved favorites yet. Analyze a recipe and tap ♡ Save to Favorites.'
    : 'No items match the current filter.'

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {SUB_TABS.map(({ id, label, count, triedCount, color }) => {
          const active = savedSubTab === id
          return (
            <button key={id} onClick={() => { setSavedSubTab(id); setSourceFilter('All'); setIngredientFilter(null) }}
              style={{ flex: 1, background: 'none', border: 'none', borderBottom: active ? `2px solid ${color}` : '2px solid transparent', color: active ? color : C.textMuted, fontSize: 13, fontWeight: active ? 600 : 400, padding: '10px 4px', cursor: 'pointer', marginBottom: -1, transition: 'color 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              {label}
              <span style={{ fontSize: 10, fontWeight: 700, background: color + '33', color, borderRadius: 10, padding: '1px 5px' }}>
                {id === 'inthelab' && count > 0 ? `${triedCount}/${count}` : count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Source filter */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {SOURCE_OPTIONS.map(opt => {
          const active = sourceFilter === opt
          return (
            <button key={opt} onClick={() => { setSourceFilter(opt); setIngredientFilter(null) }}
              style={{ background: active ? C.gold + '22' : C.surface, border: `1px solid ${active ? C.gold + '55' : C.border}`, borderRadius: 20, color: active ? C.gold : C.textMuted, fontSize: 11, fontWeight: active ? 600 : 400, padding: '3px 10px', cursor: 'pointer', transition: 'background 0.15s, color 0.15s' }}>
              {opt}
            </button>
          )
        })}
      </div>

      {/* Primary ingredient pills */}
      {sourceFilter === 'Exploration' && uniqueIngredients.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {uniqueIngredients.map(ing => {
            const active = ingredientFilter === ing
            return (
              <button key={ing} onClick={() => setIngredientFilter(active ? null : ing)}
                style={{ background: active ? C.amber + '22' : C.surface, border: `1px solid ${active ? C.amber + '55' : C.border}`, borderRadius: 20, color: active ? C.amber : C.textFaint, fontSize: 11, fontWeight: active ? 600 : 400, padding: '3px 10px', cursor: 'pointer' }}>
                {ing}
              </button>
            )
          })}
        </div>
      )}

      {filteredList.length === 0 ? (
        <p style={{ color: C.textMuted, fontSize: 14 }}>{emptyMsg}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filteredList.map(item => {
            if (savedSubTab === 'favorites') return <FavoriteCard key={item.id} fav={item} onRemove={onRemoveFavorite} onView={onViewFavorite} onUpdateNote={onUpdateNote} />
            if (savedSubTab === 'inthelab') return <InTheLabCard key={item.id} item={item} onRemove={onRemoveInTheLab} onView={onViewInTheLab} />
            return <ToMakeCard key={item.id} item={item} onRemove={onRemoveToMake} onView={onViewToMake} />
          })}
        </div>
      )}
    </div>
  )
}

// ─── Explorations ─────────────────────────────────────────────────────────────

function IngredientSearch({ inventory, selected, onSelect, onRemove }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])

  useEffect(() => {
    if (!query.trim()) { setSuggestions([]); return }
    const q = query.toLowerCase()
    setSuggestions((inventory || []).filter(i => i.spirit.toLowerCase().includes(q)).slice(0, 8))
  }, [query, inventory])

  const pick = (name) => {
    if (selected.length >= 2 || selected.includes(name)) return
    onSelect(name); setQuery(''); setSuggestions([])
  }

  const showDropdown = query.trim().length > 0 && (suggestions.length > 0 || true)
  const exactMatch = suggestions.some(s => s.spirit.toLowerCase() === query.toLowerCase())

  return (
    <div style={{ position: 'relative' }}>
      {selected.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {selected.map(ing => (
            <span key={ing} style={{ display: 'flex', alignItems: 'center', gap: 5, background: C.gold + '22', border: `1px solid ${C.gold}55`, borderRadius: 20, color: C.gold, fontSize: 13, padding: '4px 10px 4px 12px', fontWeight: 500 }}>
              {ing}
              <button onClick={() => onRemove(ing)} style={{ background: 'none', border: 'none', color: C.gold, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 0 0 2px' }}>×</button>
            </span>
          ))}
        </div>
      )}
      {selected.length < 2 && (
        <>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && query.trim() && pick(query.trim())}
            placeholder={selected.length === 0 ? 'Search or type an ingredient…' : 'Add a second ingredient…'}
            style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: '12px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
          />
          {showDropdown && (suggestions.length > 0 || query.trim()) && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#1c1c1c', border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 20, overflow: 'hidden', marginTop: 4 }}>
              {suggestions.map(item => (
                <div key={item.spirit} onClick={() => pick(item.spirit)}
                  style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.border}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span>{item.spirit}</span>
                  {item.category && <span style={{ fontSize: 11, color: C.textFaint }}>{item.category}</span>}
                </div>
              ))}
              {!exactMatch && query.trim() && (
                <div onClick={() => pick(query.trim())}
                  style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, color: C.textMuted, borderTop: suggestions.length ? `1px solid ${C.border}` : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.border}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  Use "{query.trim()}" →
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div style={{ fontSize: 12, color: C.textFaint, marginTop: 8 }}>Don't have it yet? Type any ingredient to explore.</div>
    </div>
  )
}

// ─── Exploration history helpers ─────────────────────────────────────────────

const EXPLORATION_LS_KEY = 'bar-cart-explorations-history'
const EXPLORATION_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const EXPLORATION_STYLE_EMOJI = {
  'Stirred': '🥃', 'On the Rocks': '🧊', 'Shaken / Sours': '🍋',
  'Highball': '🫧', 'Tiki / Swizzle': '🌺', 'Warm Drink': '☕',
}

function makeExplorationKey(ingredients, style, flavors, lowABV) {
  return [[...ingredients].sort().join(','), style, [...flavors].sort().join(','), String(lowABV)].join('|')
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function loadLocalExplorationHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPLORATION_LS_KEY)) || []
    const cutoff = Date.now() - EXPLORATION_HISTORY_MAX_AGE_MS
    return raw.filter(e => new Date(e.updated_at).getTime() > cutoff)
  } catch { return [] }
}

function saveLocalExplorationHistory(entries) {
  try { localStorage.setItem(EXPLORATION_LS_KEY, JSON.stringify(entries)) } catch {}
}

function upsertLocalExplorationHistory(entry) {
  let entries = loadLocalExplorationHistory()
  const idx = entries.findIndex(e => e.search_key === entry.search_key)
  if (idx >= 0) { entries[idx] = entry } else { entries.unshift(entry) }
  entries.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
  const pruned = entries.slice(0, 20)
  saveLocalExplorationHistory(pruned)
  return pruned
}

function removeLocalExplorationHistory(searchKey) {
  const entries = loadLocalExplorationHistory().filter(e => e.search_key !== searchKey)
  saveLocalExplorationHistory(entries)
  return entries
}

function ExplorationResultCard({ suggestion, primaryIngredients, onSaveOnDeck, onSaveInTheLab }) {
  const [expanded, setExpanded] = useState(false)
  const [savedTo, setSavedTo] = useState(null) // null | 'ondeck' | 'inthelab'
  const [tweakedSuggestion, setTweakedSuggestion] = useState(null)
  const [isTweaking, setIsTweaking] = useState(false)
  const [tweakText, setTweakText] = useState('')
  const [isTweakLoading, setIsTweakLoading] = useState(false)
  const [tweakDone, setTweakDone] = useState(false)
  const [tweakError, setTweakError] = useState(null)

  const displayed = tweakedSuggestion || suggestion

  const handleOnDeck = () => {
    onSaveOnDeck(displayed, primaryIngredients)
    setSavedTo('ondeck')
  }
  const handleInLab = () => {
    onSaveInTheLab(displayed, primaryIngredients)
    setSavedTo('inthelab')
  }
  const handleTweakSubmit = async () => {
    if (!tweakText.trim() || isTweakLoading) return
    setIsTweakLoading(true)
    setTweakError(null)
    try {
      const revised = await tweakSingleSuggestion(displayed, tweakText.trim())
      setTweakedSuggestion(revised)
      setTweakDone(true)
      setIsTweaking(false)
      setTweakText('')
    } catch (err) {
      setTweakError(err.message || 'Could not tweak this suggestion. Please try again.')
    } finally {
      setIsTweakLoading(false)
    }
  }

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ opacity: isTweakLoading ? 0.4 : 1, transition: 'opacity 0.3s', pointerEvents: isTweakLoading ? 'none' : 'auto' }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: C.gold }}>{displayed.recipe_name || 'Untitled suggestion'}</span>
          {displayed.glass_type && <GlassIcon type={displayed.glass_type} />}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
          <OriginBadge originFlag={displayed.origin_flag} />
          <DifficultyBadge difficulty={displayed.difficulty} />
        </div>
        {displayed.difficulty_note && <div style={{ fontSize: 12, color: C.textFaint, marginTop: 2 }}>{displayed.difficulty_note}</div>}
      </div>

      {displayed.summary && <p style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.55, marginBottom: 10 }}>{displayed.summary}</p>}

      <button onClick={() => setExpanded(e => !e)}
        style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0, marginBottom: expanded ? 12 : 0 }}>
        {expanded ? '▲ Hide recipe' : '▼ Show recipe & ingredients'}
      </button>

      {expanded && (
        <div>
          {displayed.recipe && displayed.recipe.length > 0 && (
            <div style={{ background: C.bg, borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 10 }}>Recipe</div>
              <ul style={{ listStyle: 'none' }}>
                {displayed.recipe.map((r, i) => (
                  <li key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < displayed.recipe.length - 1 ? `1px solid ${C.border}` : 'none', gap: 12 }}>
                    <span style={{ fontSize: 14 }}>{r.ingredient}</span>
                    <span style={{ fontSize: 13, color: C.gold, fontWeight: 500, whiteSpace: 'nowrap' }}>{r.amount}</span>
                  </li>
                ))}
              </ul>
              {displayed.instructions && (
                <p style={{ fontSize: 13, color: C.textMuted, marginTop: 10, lineHeight: 1.6, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>{displayed.instructions}</p>
              )}
            </div>
          )}
          {displayed.technique_notes && (
            <div style={{ fontSize: 13, color: C.amber, background: C.amber + '12', border: `1px solid ${C.amber}33`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              🔧 {displayed.technique_notes}
            </div>
          )}
          {displayed.ingredients && displayed.ingredients.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {displayed.ingredients.filter(ing => ing.ingredient).map((ing, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
                  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: ing.status === 'found' ? C.green : ing.status === 'substitute' ? C.amber : C.red, flexShrink: 0, marginTop: 4 }} />
                  <div>
                    <span style={{ color: C.text }}>{ing.ingredient}</span>
                    {ing.location && <span style={{ color: C.textMuted }}> · 📍 {ing.location}</span>}
                    {ing.substitute && <div style={{ color: C.textFaint, fontStyle: 'italic', marginTop: 2 }}>Sub: {ing.substitute}{ing.flavor_impact ? ` — ${ing.flavor_impact}` : ''}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {savedTo ? (
        <div style={{ marginTop: 12, fontSize: 13, color: C.textFaint, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>✓ Saved to {savedTo === 'ondeck' ? 'On Deck' : 'In the Lab'}</span>
          <button onClick={savedTo === 'ondeck' ? handleInLab : handleOnDeck}
            style={{ background: 'none', border: 'none', color: C.gold, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
            Move to {savedTo === 'ondeck' ? 'In the Lab' : 'On Deck'} instead?
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={handleOnDeck} style={{ background: 'none', border: `1px solid ${C.blue}`, borderRadius: 20, color: C.blue, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>🍹 On Deck</button>
          <button onClick={handleInLab} style={{ background: 'none', border: `1px solid ${C.amber}`, borderRadius: 20, color: C.amber, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>🧪 In the Lab</button>
          <button style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textFaint, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>👎 Archive</button>
        </div>
      )}
      </div>

      <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        {tweakDone && !isTweaking && (
          <div style={{ fontSize: 12, color: C.green, marginBottom: 6 }}>✓ Tweaked</div>
        )}
        {!isTweaking ? (
          <button onClick={() => { setIsTweaking(true); setTweakDone(false) }}
            style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0 }}>
            ✏️ Tweak this
          </button>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={tweakText}
                onChange={e => setTweakText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleTweakSubmit()}
                placeholder="e.g. make it less sweet, use bourbon instead"
                disabled={isTweakLoading}
                autoFocus
                style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: '7px 10px', outline: 'none', opacity: isTweakLoading ? 0.5 : 1 }}
              />
              <button
                onClick={handleTweakSubmit}
                disabled={!tweakText.trim() || isTweakLoading}
                style={{ background: tweakText.trim() && !isTweakLoading ? C.gold : C.surface, border: `1px solid ${tweakText.trim() && !isTweakLoading ? C.gold : C.border}`, borderRadius: 6, color: tweakText.trim() && !isTweakLoading ? '#0f0f0f' : C.textFaint, fontSize: 12, fontWeight: 600, padding: '7px 12px', cursor: tweakText.trim() && !isTweakLoading ? 'pointer' : 'default', transition: 'background 0.15s, color 0.15s', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                {isTweakLoading && <span style={{ display: 'inline-block', width: 11, height: 11, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'bcspini 0.6s linear infinite', flexShrink: 0 }} />}
                {isTweakLoading ? 'Tweaking…' : 'Tweak'}
              </button>
              <button
                onClick={() => { setIsTweaking(false); setTweakText(''); setTweakError(null) }}
                disabled={isTweakLoading}
                style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.textFaint, fontSize: 12, padding: '7px 10px', cursor: isTweakLoading ? 'default' : 'pointer' }}>
                ✕
              </button>
            </div>
            {tweakError && <div style={{ fontSize: 12, color: C.red, marginTop: 6 }}>{tweakError}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

const EXPLORE_LOADING_MSGS = [
  'Searching published cocktail recipes…',
  'Crafting original ideas for your ingredients…',
  'Matching against your inventory…',
  'Almost there…',
]

function ExplorationsScreen({ inventory, inventoryText, onSaveOnDeck, onSaveInTheLab, user }) {
  const [step, setStep] = useState('ingredients')
  const [selected, setSelected] = useState([])
  const [style, setStyle] = useState(null)
  const [flavors, setFlavors] = useState([])
  const [lowABV, setLowABV] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [isFeedbackLoading, setIsFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState(null)
  const [feedbackBanner, setFeedbackBanner] = useState(false)
  const feedbackBannerRef = useRef(null)
  const [history, setHistory] = useState([])
  const [partialSource, setPartialSource] = useState(null)
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0)

  useEffect(() => {
    const load = async () => {
      if (user) {
        const cutoff = new Date(Date.now() - EXPLORATION_HISTORY_MAX_AGE_MS).toISOString()
        await supabase.from('explorations_history').delete().eq('user_id', user.id).lt('updated_at', cutoff)
        const { data } = await supabase
          .from('explorations_history')
          .select('search_key,primary_ingredients,cocktail_style,flavor_profile,low_abv,result,updated_at')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false })
          .limit(20)
        if (data) setHistory(data)
      } else {
        setHistory(loadLocalExplorationHistory())
      }
    }
    load()
  }, [user?.id])

  useEffect(() => {
    if (step !== 'loading') return
    setLoadingMsgIdx(0)
    const id = setInterval(() => setLoadingMsgIdx(prev => (prev + 1) % EXPLORE_LOADING_MSGS.length), 8000)
    return () => clearInterval(id)
  }, [step])

  const upsertHistory = (ingredients, searchStyle, searchFlavors, searchLowABV, searchResult) => {
    const entry = {
      search_key: makeExplorationKey(ingredients, searchStyle, searchFlavors, searchLowABV),
      primary_ingredients: [...ingredients].sort(),
      cocktail_style: searchStyle,
      flavor_profile: [...searchFlavors].sort(),
      low_abv: searchLowABV,
      result: searchResult,
      updated_at: new Date().toISOString(),
    }
    if (user) {
      supabase.from('explorations_history').upsert(
        { user_id: user.id, ...entry },
        { onConflict: 'user_id,search_key' }
      ).then()
    }
    setHistory(prev => {
      const filtered = prev.filter(e => e.search_key !== entry.search_key)
      const updated = [entry, ...filtered].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 20)
      if (!user) saveLocalExplorationHistory(updated)
      return updated
    })
  }

  const handleRemoveHistory = (searchKey) => {
    if (user) {
      supabase.from('explorations_history').delete().eq('user_id', user.id).eq('search_key', searchKey).then()
    }
    setHistory(prev => {
      const updated = prev.filter(e => e.search_key !== searchKey)
      if (!user) saveLocalExplorationHistory(updated)
      return updated
    })
  }

  const restoreFromHistory = (entry) => {
    setSelected(entry.primary_ingredients)
    setStyle(entry.cocktail_style)
    setFlavors(entry.flavor_profile)
    setLowABV(entry.low_abv)
    setResult(entry.result)
    setError(null)
    setFeedback('')
    setFeedbackError(null)
    setFeedbackBanner(false)
    setPartialSource(null)
    setStep('results')
  }

  const STYLES = [
    { id: 'Stirred', emoji: '🥃' }, { id: 'On the Rocks', emoji: '🧊' },
    { id: 'Shaken / Sours', emoji: '🍋' }, { id: 'Highball', emoji: '🫧' },
    { id: 'Tiki / Swizzle', emoji: '🌺' }, { id: 'Warm Drink', emoji: '☕' },
  ]
  const FLAVORS = [
    { id: 'Bright & Citrusy', emoji: '🍋' }, { id: 'Bitter / Herbal', emoji: '🌿' },
    { id: 'Spirit Forward / Dry', emoji: '🥃' }, { id: 'Earthy / Smoky', emoji: '🍂' },
    { id: 'Fruity / Sweet', emoji: '🍓' },
  ]

  const toggleFlavor = id => setFlavors(prev => prev.includes(id) ? prev.filter(f => f !== id) : prev.length < 3 ? [...prev, id] : prev)

  const handleExplore = async () => {
    setStep('loading')
    setPartialSource(null)
    try {
      const { result: data, partialSource: ps } = await analyzeExplorations(selected, style, flavors, lowABV, inventoryText)
      setResult(data)
      setPartialSource(ps)
      setStep('results')
      if (!data.incompatible) upsertHistory(selected, style, flavors, lowABV, data)
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStep('error')
    }
  }

  const reset = () => { setStep('ingredients'); setSelected([]); setStyle(null); setFlavors([]); setLowABV(false); setResult(null); setError(null); setFeedback(''); setFeedbackError(null); setFeedbackBanner(false); setPartialSource(null) }

  const handleFeedback = async () => {
    if (!feedback.trim() || isFeedbackLoading) return
    setIsFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const previousNames = (result?.suggestions || []).map(s => s.recipe_name)
      const data = await refineExplorations(selected, style, flavors, lowABV, inventoryText, previousNames, feedback.trim())
      setResult(data)
      setFeedback('')
      setFeedbackBanner(true)
      setTimeout(() => feedbackBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
      setTimeout(() => setFeedbackBanner(false), 4000)
      upsertHistory(selected, style, flavors, lowABV, data)
    } catch (err) {
      setFeedbackError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setIsFeedbackLoading(false)
    }
  }

  if (step === 'ingredients') return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-0.02em', marginBottom: 4 }}>Explorations</div>
      <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 24, lineHeight: 1.55 }}>Pick up to 2 ingredients and we'll suggest cocktails you can make — or inspire you to try something new.</div>
      {history.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 10 }}>Recent Searches</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map((entry, i) => (
              <div key={entry.search_key || i}
                style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }}
                onClick={() => restoreFromHistory(entry)}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{EXPLORATION_STYLE_EMOJI[entry.cocktail_style] || '✨'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.primary_ingredients.join(' + ')}</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginTop: 1 }}>{entry.cocktail_style} · {relativeTime(entry.updated_at)}</div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); handleRemoveHistory(entry.search_key) }}
                  style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 14, cursor: 'pointer', padding: '2px 6px', flexShrink: 0 }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <IngredientSearch inventory={inventory} selected={selected} onSelect={ing => setSelected(p => [...p, ing])} onRemove={ing => setSelected(p => p.filter(i => i !== ing))} />
      {selected.length > 0 && (
        <button onClick={() => setStep('prefs')} style={{ width: '100%', background: C.gold, border: 'none', borderRadius: 10, color: '#0f0f0f', fontWeight: 700, fontSize: 15, padding: '13px', cursor: 'pointer', marginTop: 24 }}>
          Next →
        </button>
      )}
    </div>
  )

  if (step === 'prefs') return (
    <div>
      <button onClick={() => setStep('ingredients')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>← Back</button>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>Style & Preferences</div>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 24 }}>Exploring: <span style={{ color: C.gold }}>{selected.join(' + ')}</span></div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 12 }}>Cocktail Style</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {STYLES.map(s => (
            <button key={s.id} onClick={() => setStyle(s.id)}
              style={{ background: style === s.id ? C.gold + '22' : C.surface, border: `1px solid ${style === s.id ? C.gold + '66' : C.border}`, borderRadius: 10, color: style === s.id ? C.gold : C.text, fontSize: 14, fontWeight: style === s.id ? 600 : 400, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, transition: 'background 0.15s, color 0.15s' }}>
              <span>{s.emoji}</span><span>{s.id}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 4 }}>Flavor Profile</div>
        <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 12 }}>Pick 1–3</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FLAVORS.map(f => {
            const active = flavors.includes(f.id)
            return (
              <button key={f.id} onClick={() => toggleFlavor(f.id)}
                style={{ background: active ? C.gold + '22' : C.surface, border: `1px solid ${active ? C.gold + '66' : C.border}`, borderRadius: 10, color: active ? C.gold : C.text, fontSize: 14, fontWeight: active ? 600 : 400, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, transition: 'background 0.15s, color 0.15s' }}>
                <span>{f.emoji}</span><span style={{ flex: 1 }}>{f.id}</span>{active && <span style={{ fontSize: 12 }}>✓</span>}
              </button>
            )
          })}
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 24 }}>
        <input type="checkbox" checked={lowABV} onChange={e => setLowABV(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.gold, cursor: 'pointer', flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 14, color: C.text }}>Keep it low ABV</div>
          <div style={{ fontSize: 12, color: C.textFaint, marginTop: 2 }}>Prefer lighter, lower-alcohol options</div>
        </div>
      </label>

      <button onClick={handleExplore} disabled={!style}
        style={{ width: '100%', background: style ? C.gold : C.surface, border: `1px solid ${style ? C.gold : C.border}`, borderRadius: 10, color: style ? '#0f0f0f' : C.textFaint, fontWeight: 700, fontSize: 15, padding: '13px', cursor: style ? 'pointer' : 'default', transition: 'background 0.15s, color 0.15s' }}>
        ✨ Explore
      </button>
    </div>
  )

  if (step === 'loading') return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '65vh', textAlign: 'center', padding: '0 24px' }}>
      <style>{`@keyframes bcspin2 { to { transform: rotate(360deg); } }`}</style>
      <div style={{ fontSize: 52, marginBottom: 24, lineHeight: 1 }}>🍸</div>
      <div style={{ width: 48, height: 48, border: `3px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'bcspin2 0.75s linear infinite', marginBottom: 28 }} />
      <div style={{ color: C.text, fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Searching recipes and crafting originals…</div>
      <div style={{ color: C.textMuted, fontSize: 14, minHeight: 22, transition: 'opacity 0.4s' }}>{EXPLORE_LOADING_MSGS[loadingMsgIdx]}</div>
    </div>
  )

  if (step === 'error') return (
    <div>
      <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 10, padding: '14px 16px', fontSize: 14, color: C.red, marginBottom: 16 }}>{error}</div>
      <button onClick={reset} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }}>Try again</button>
    </div>
  )

  if (step === 'results' && result) {
    if (result.incompatible) return (
      <div>
        <div style={{ background: C.amber + '15', border: `1px solid ${C.amber}44`, borderRadius: 10, padding: '20px', marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, marginBottom: 8 }}>These don't quite mix…</div>
          <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6 }}>{result.incompatibility_reason}</div>
        </div>
        <button onClick={reset} style={{ background: C.gold, border: 'none', borderRadius: 10, color: '#0f0f0f', fontWeight: 700, fontSize: 14, padding: '12px 20px', cursor: 'pointer' }}>Try different ingredients</button>
      </div>
    )

    const canMake = (result.suggestions || []).filter(s => s.can_make_now)
    const worthBuying = (result.suggestions || []).filter(s => !s.can_make_now)

    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 700, color: C.text }}>{selected.join(' + ')}</div>
          <button onClick={reset} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textMuted, fontSize: 12, padding: '5px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Start over</button>
        </div>
        {partialSource && (
          <div style={{ background: C.amber + '12', border: `1px solid ${C.amber}33`, borderRadius: 8, padding: '8px 14px', marginBottom: 16, fontSize: 13, color: C.textMuted }}>
            Some results unavailable — showing {partialSource === 'web' ? 'original' : 'web'} suggestions only
          </div>
        )}
        {result.flavor_profile_note && (
          <div style={{ background: C.gold + '12', border: `1px solid ${C.gold}33`, borderRadius: 10, padding: '12px 16px', marginBottom: result.pairs_well_with ? 8 : 24, fontSize: 14, color: C.text, lineHeight: 1.6 }}>
            ✨ {result.flavor_profile_note}
          </div>
        )}
        {result.pairs_well_with && (
          <div style={{ background: C.amber + '12', border: `1px solid ${C.amber}33`, borderRadius: 10, padding: '12px 16px', marginBottom: 24, fontSize: 14, color: C.text, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: C.amber, marginBottom: 4 }}>🔗 Pairs Well With</div>
            {result.pairs_well_with}
          </div>
        )}
        <div style={{ opacity: isFeedbackLoading ? 0.4 : 1, transition: 'opacity 0.3s', pointerEvents: isFeedbackLoading ? 'none' : 'auto' }}>
          {canMake.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.green, marginBottom: 12 }}>Can Make Now ({canMake.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {canMake.map((s, i) => <ExplorationResultCard key={i} suggestion={s} primaryIngredients={selected} onSaveOnDeck={onSaveOnDeck} onSaveInTheLab={onSaveInTheLab} />)}
              </div>
            </div>
          )}
          {worthBuying.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.amber, marginBottom: 12 }}>Worth Buying For ({worthBuying.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {worthBuying.map((s, i) => <ExplorationResultCard key={i} suggestion={s} primaryIngredients={selected} onSaveOnDeck={onSaveOnDeck} onSaveInTheLab={onSaveInTheLab} />)}
              </div>
            </div>
          )}
        </div>
        <div ref={feedbackBannerRef}>
          {feedbackBanner && (
            <div style={{ background: C.green + '15', border: `1px solid ${C.green}44`, borderRadius: 10, padding: '10px 16px', marginBottom: 16, fontSize: 14, color: C.green }}>
              ✓ Updated based on your feedback
            </div>
          )}
        </div>
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
          <style>{`@keyframes bcspini { to { transform: rotate(360deg); } }`}</style>
          <div style={{ fontSize: 13, color: isFeedbackLoading ? C.textMuted : C.textMuted, marginBottom: 10 }}>
            {isFeedbackLoading ? 'Revising based on your feedback…' : 'Want different results? Tell us what you\'re looking for:'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleFeedback()}
              placeholder="e.g. more stone fruit, less sweet, something with mezcal instead"
              disabled={isFeedbackLoading}
              style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, padding: '10px 14px', outline: 'none', opacity: isFeedbackLoading ? 0.5 : 1 }}
            />
            <button
              onClick={handleFeedback}
              disabled={!feedback.trim() || isFeedbackLoading}
              style={{ background: feedback.trim() && !isFeedbackLoading ? C.gold : C.surface, border: `1px solid ${feedback.trim() && !isFeedbackLoading ? C.gold : C.border}`, borderRadius: 8, color: feedback.trim() && !isFeedbackLoading ? '#0f0f0f' : C.textFaint, fontSize: 13, fontWeight: 600, padding: '10px 16px', cursor: feedback.trim() && !isFeedbackLoading ? 'pointer' : 'default', whiteSpace: 'nowrap', transition: 'background 0.15s, color 0.15s', display: 'flex', alignItems: 'center', gap: 6 }}>
              {isFeedbackLoading && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'bcspini 0.6s linear infinite', flexShrink: 0 }} />}
              {isFeedbackLoading ? 'Revising…' : 'Refine'}
            </button>
          </div>
          {feedbackError && <div style={{ fontSize: 13, color: C.red, marginTop: 8 }}>{feedbackError}</div>}
        </div>
      </div>
    )
  }

  return null
}

// ─── Bottom Tab Bar ───────────────────────────────────────────────────────────

function BottomTabBar({ screen, onTab }) {
  const tabs = [
    { id: 'analyze',      icon: '🔍', label: 'Analyze' },
    { id: 'explorations', icon: '✨', label: 'Explorations' },
    { id: 'saved',        icon: '🍸', label: 'Saved' },
    { id: 'inventory',    icon: '📦', label: 'Inventory' },
    { id: 'shopping',     icon: '🛒', label: 'Shopping' },
  ]
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: C.bg, borderTop: `1px solid ${C.border}`, display: 'flex', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {tabs.map(({ id, icon, label }) => {
        const active = screen === id
        return (
          <button key={id} onClick={() => onTab(id)}
            style={{ flex: 1, background: 'none', border: 'none', color: active ? C.gold : C.textMuted, padding: '10px 4px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, transition: 'color 0.15s' }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 400, letterSpacing: '0.02em' }}>{label}</span>
          </button>
        )
      })}
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
  const [, setAffinityBackfillInProgress] = useState(false)

  // Navigation
  const [screen, setScreen] = useState('analyze')
  const [savedSubTab, setSavedSubTab] = useState('ondeck')

  // Auth
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const dataLoadedForRef = useRef(null)
  const shoppingListRef = useRef([])

  // Persisted state
  const [shoppingList, setShoppingList] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-shopping')) || [] } catch { return [] }
  })
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-favorites')) || [] } catch { return [] }
  })
  const [toMake, setToMake] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-to-make')) || [] } catch { return [] }
  })
  const [inTheLabList, setInTheLabList] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bar-cart-in-the-lab')) || [] } catch { return [] }
  })

  useEffect(() => { shoppingListRef.current = shoppingList }, [shoppingList])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-shopping', JSON.stringify(shoppingList)) }, [shoppingList, user])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-favorites', JSON.stringify(favorites)) }, [favorites, user])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-to-make', JSON.stringify(toMake)) }, [toMake, user])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-in-the-lab', JSON.stringify(inTheLabList)) }, [inTheLabList, user])

  // DB helpers
  const dbFavToLocal = (row) => ({
    id: row.id, recipeName: row.recipe_name, summary: row.summary,
    recipe: row.recipe || [], instructions: row.instructions || null,
    ingredients: row.ingredients || [], variations: row.variations || [],
    glassType: row.glass_type || null, note: row.notes || '', mode: row.mode,
    source: row.source || 'manual', originFlag: row.origin_flag || null,
    difficulty: row.difficulty || null, primaryIngredients: row.primary_ingredients || [],
    savedAt: row.saved_at,
  })

  const dbToMakeToLocal = (row) => ({
    id: row.id, recipeName: row.recipe_name, summary: row.summary,
    recipe: row.recipe || [], instructions: row.instructions || null,
    ingredients: row.ingredients || [], variations: row.variations || [],
    glassType: row.glass_type || null, mode: row.mode,
    source: row.source || 'manual', originFlag: row.origin_flag || null,
    difficulty: row.difficulty || null, primaryIngredients: row.primary_ingredients || [],
    savedAt: row.saved_at,
  })

  const dbInTheLabToLocal = (row) => ({
    id: row.id, recipeName: row.recipe_name, summary: row.summary,
    recipe: row.recipe || [], instructions: row.instructions || null,
    ingredients: row.ingredients || [], variations: row.variations || [],
    glassType: row.glass_type || null, note: row.notes || '', mode: row.mode,
    source: row.source || 'Exploration', originFlag: row.origin_flag || null,
    difficulty: row.difficulty || null, primaryIngredients: row.primary_ingredients || [],
    tried: row.tried || false,
    originalRecipe: row.original_recipe || null,
    originalInstructions: row.original_instructions || null,
    originalSummary: row.original_summary || null,
    originalGlassType: row.original_glass_type || null,
    savedAt: row.saved_at,
  })

  const migrateAndLoadData = async (u) => {
    const [{ data: favData }, { data: shopData }, { data: toMakeData }] = await Promise.all([
      supabase.from('favorites').select('*').eq('user_id', u.id).order('saved_at', { ascending: false }),
      supabase.from('shopping_list').select('*').eq('user_id', u.id).order('created_at', { ascending: true }),
      supabase.from('to_make').select('*').eq('user_id', u.id).order('saved_at', { ascending: false }),
    ])

    let labData = null
    try {
      const { data, error } = await supabase.from('in_the_lab').select('*').eq('user_id', u.id).order('saved_at', { ascending: false })
      if (!error) labData = data
    } catch (_) {}

    const hasCloudData = (favData?.length > 0) || (shopData?.length > 0) || (toMakeData?.length > 0) || (labData?.length > 0)

    if (!hasCloudData) {
      const localFavs = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-favorites')) || [] } catch { return [] } })()
      const localShopping = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-shopping')) || [] } catch { return [] } })()
      const localToMake = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-to-make')) || [] } catch { return [] } })()
      const localLab = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-in-the-lab')) || [] } catch { return [] } })()

      if (localFavs.length > 0) {
        const rows = localFavs.map(f => ({ user_id: u.id, recipe_name: f.recipeName, summary: f.summary || null, recipe: f.recipe || [], instructions: f.instructions || null, ingredients: f.ingredients || [], variations: f.variations || [], glass_type: f.glassType || null, notes: f.note || null, saved_at: f.savedAt || new Date().toISOString() }))
        const { data: inserted } = await supabase.from('favorites').upsert(rows, { onConflict: 'user_id,recipe_name', ignoreDuplicates: true }).select()
        if (inserted) setFavorites(inserted.map(dbFavToLocal))
      }
      if (localShopping.length > 0) {
        const rows = localShopping.map(i => ({ user_id: u.id, name: i.name }))
        const { data: inserted } = await supabase.from('shopping_list').upsert(rows, { onConflict: 'user_id,name', ignoreDuplicates: true }).select()
        if (inserted) setShoppingList(inserted.map(r => ({ id: r.id, name: r.name })))
      }
      if (localToMake.length > 0) {
        const rows = localToMake.map(f => ({ user_id: u.id, recipe_name: f.recipeName, summary: f.summary || null, recipe: f.recipe || [], instructions: f.instructions || null, ingredients: f.ingredients || [], variations: f.variations || [], glass_type: f.glassType || null, saved_at: f.savedAt || new Date().toISOString() }))
        const { data: inserted } = await supabase.from('to_make').upsert(rows, { onConflict: 'user_id,recipe_name', ignoreDuplicates: true }).select()
        if (inserted) setToMake(inserted.map(dbToMakeToLocal))
      }
      if (localLab.length > 0) {
        try {
          const rows = localLab.map(f => ({ user_id: u.id, recipe_name: f.recipeName, summary: f.summary || null, recipe: f.recipe || [], instructions: f.instructions || null, ingredients: f.ingredients || [], variations: f.variations || [], glass_type: f.glassType || null, source: f.source || 'Exploration', origin_flag: f.originFlag || null, difficulty: f.difficulty || null, primary_ingredients: f.primaryIngredients || [], saved_at: f.savedAt || new Date().toISOString() }))
          const { data: inserted } = await supabase.from('in_the_lab').upsert(rows, { onConflict: 'user_id,recipe_name', ignoreDuplicates: true }).select()
          if (inserted) setInTheLabList(inserted.map(dbInTheLabToLocal))
        } catch (_) {}
      }
    } else {
      if (favData) setFavorites(favData.map(dbFavToLocal))
      if (shopData) setShoppingList(shopData.map(r => ({ id: r.id, name: r.name })))
      if (toMakeData) setToMake(toMakeData.map(dbToMakeToLocal))
      if (labData) setInTheLabList(labData.map(dbInTheLabToLocal))
    }

    localStorage.removeItem('bar-cart-favorites')
    localStorage.removeItem('bar-cart-shopping')
    localStorage.removeItem('bar-cart-to-make')
    localStorage.removeItem('bar-cart-in-the-lab')
  }

  // Auth effect
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const newUser = session?.user ?? null
      setUser(newUser)
      setAuthLoading(false)
      if (newUser) {
        if (dataLoadedForRef.current !== newUser.id) {
          dataLoadedForRef.current = newUser.id
          migrateAndLoadData(newUser)
        }
      } else if (event === 'SIGNED_OUT' || (!newUser && event === 'TOKEN_REFRESHED')) {
        dataLoadedForRef.current = null
        setUser(null)
        supabase.auth.signOut().catch(() => {})
        try { setFavorites(JSON.parse(localStorage.getItem('bar-cart-favorites')) || []) } catch { setFavorites([]) }
        try { setShoppingList(JSON.parse(localStorage.getItem('bar-cart-shopping')) || []) } catch { setShoppingList([]) }
        try { setToMake(JSON.parse(localStorage.getItem('bar-cart-to-make')) || []) } catch { setToMake([]) }
        try { setInTheLabList(JSON.parse(localStorage.getItem('bar-cart-in-the-lab')) || []) } catch { setInTheLabList([]) }
      }
    })
    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  const [adjustmentNote, setAdjustmentNote] = useState(null)
  const [resultSource, setResultSource] = useState(null) // 'ondeck' | 'favorites' | null
  const [currentLabItem, setCurrentLabItem] = useState(null)
  const sourceScrollRef = useRef(0)
  const [sharedImage, setSharedImage] = useState(null) // pending share-target file awaiting mode selection

  // Inventory loading
  const loadInventory = useCallback(async (url) => {
    setInventoryLoading(true); setInventoryError(null); setInventory(null)
    try {
      const bustUrl = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`
      const res = await fetch(bustUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = parseInventory(await res.text())
      setInventory(parsed)

      // Fire-and-forget affinity backfill for ingredients not yet analyzed
      ;(async () => {
        try {
          const excludedNorm = EXCLUDE_FROM_INVENTORY.map(e => e.trim().toLowerCase())
          const candidates = parsed
            .filter(item => !item.oos)
            .filter(item => !excludedNorm.some(ex => item.spirit.trim().toLowerCase().includes(ex)))
            .map(item => ({ name: item.spirit.trim(), normName: item.spirit.trim().toLowerCase(), category: item.category.trim() }))

          if (candidates.length === 0) return

          const { data: existing, error: fetchErr } = await supabase
            .from('ingredient_affinities')
            .select('ingredient_name')
            .in('ingredient_name', candidates.map(c => c.normName))

          if (fetchErr) { console.warn('[affinities] fetch error:', fetchErr.message); return }

          const existingSet = new Set((existing || []).map(r => r.ingredient_name))
          const newIngredients = candidates.filter(c => !existingSet.has(c.normName))

          if (newIngredients.length === 0) { console.log('[affinities] all ingredients up to date'); return }

          console.log(`[affinities] analyzing ${newIngredients.length} new ingredient(s):`, newIngredients.map(c => c.name))
          setAffinityBackfillInProgress(true)

          const response = await fetch('/api/backfill-affinities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ingredients: newIngredients.map(c => ({ name: c.name, category: c.category })) }),
          })

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: response.statusText }))
            throw new Error(err.error || `HTTP ${response.status}`)
          }

          const result = await response.json()
          console.log(`[affinities] backfill complete: ${result.count} ingredient(s) stored`)
        } catch (err) {
          console.warn('[affinities] backfill failed (non-blocking):', err.message)
        } finally {
          setAffinityBackfillInProgress(false)
        }
      })()
    } catch (err) {
      setInventoryError(err.message)
    } finally {
      setInventoryLoading(false)
    }
  }, [])

  useEffect(() => { loadInventory(sheetUrl) }, [sheetUrl, loadInventory])

  // Read shared image from service worker cache when launched via share target
  useEffect(() => {
    if (!window.location.search.includes('shared=1')) return
    const readSharedImage = async () => {
      try {
        const cache = await caches.open('bar-cart-share-v1')
        const response = await cache.match('/shared-image')
        if (!response) return
        const blob = await response.blob()
        const file = new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' })
        await cache.delete('/shared-image')
        setSharedImage(file)
        window.history.replaceState({}, '', '/')
      } catch (_) { /* silently ignore if cache API unavailable */ }
    }
    readSharedImage()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleReload = () => {
    if (sheetUrlInput === sheetUrl) loadInventory(sheetUrlInput)
    else setSheetUrl(sheetUrlInput)
  }

  const inStockCount = inventory ? inventory.filter(i => !i.oos).length : 0
  const oosCount = inventory ? inventory.filter(i => i.oos).length : 0

  // Shopping list helpers
  const addToShopping = useCallback(async (name) => {
    if (shoppingListRef.current.some(i => i.name.toLowerCase() === name.toLowerCase())) return
    if (user) {
      const { data, error } = await supabase.from('shopping_list').insert({ user_id: user.id, name }).select().single()
      if (!error && data) setShoppingList(prev => [...prev, { id: data.id, name: data.name }])
    } else {
      setShoppingList(prev => {
        if (prev.some(i => i.name.toLowerCase() === name.toLowerCase())) return prev
        return [...prev, { id: Date.now() + Math.random(), name }]
      })
    }
  }, [user])

  const removeFromShopping = async (id) => {
    if (user) await supabase.from('shopping_list').delete().eq('id', id)
    setShoppingList(prev => prev.filter(i => i.id !== id))
  }

  const clearShopping = async () => {
    if (user) await supabase.from('shopping_list').delete().eq('user_id', user.id)
    setShoppingList([])
  }

  // Favorites helpers
  const toggleFavorite = async (res, extras = {}) => {
    const { source = 'manual', originFlag = null, difficulty = null, primaryIngredients = [] } = extras
    if (user) {
      const existing = favorites.find(f => f.recipeName === res.recipe_name)
      if (existing) {
        await supabase.from('favorites').delete().eq('id', existing.id)
        setFavorites(prev => prev.filter(f => f.id !== existing.id))
      } else {
        const { data, error } = await supabase.from('favorites').insert({
          user_id: user.id, recipe_name: res.recipe_name, summary: res.summary || null,
          recipe: res.recipe || [], instructions: res.instructions || null,
          ingredients: res.ingredients || [], variations: res.variations || [],
          glass_type: res.glass_type || null, source, origin_flag: originFlag,
          difficulty, primary_ingredients: primaryIngredients, saved_at: new Date().toISOString(),
        }).select().single()
        if (!error && data) setFavorites(prev => [dbFavToLocal(data), ...prev])
      }
    } else {
      setFavorites(prev => {
        const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
        if (existing >= 0) return prev.filter((_, i) => i !== existing)
        return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, instructions: res.instructions || null, ingredients: res.ingredients, variations: res.variations, glassType: res.glass_type || null, note: '', source, originFlag, difficulty, primaryIngredients, savedAt: new Date().toISOString() }, ...prev]
      })
    }
  }

  const removeFavorite = async (id) => {
    if (user) await supabase.from('favorites').delete().eq('id', id)
    setFavorites(prev => prev.filter(f => f.id !== id))
  }

  const updateFavoriteNote = async (id, note) => {
    if (user) await supabase.from('favorites').update({ notes: note }).eq('id', id)
    setFavorites(prev => prev.map(f => f.id === id ? { ...f, note } : f))
  }

  // To Make helpers
  const toggleToMake = async (res, extras = {}) => {
    const { source = 'manual', originFlag = null, difficulty = null, primaryIngredients = [] } = extras
    if (user) {
      const existing = toMake.find(f => f.recipeName === res.recipe_name)
      if (existing) {
        await supabase.from('to_make').delete().eq('id', existing.id)
        setToMake(prev => prev.filter(f => f.id !== existing.id))
      } else {
        const { data, error } = await supabase.from('to_make').insert({
          user_id: user.id, recipe_name: res.recipe_name, summary: res.summary || null,
          recipe: res.recipe || [], instructions: res.instructions || null,
          ingredients: res.ingredients || [], variations: res.variations || [],
          glass_type: res.glass_type || null, source, origin_flag: originFlag,
          difficulty, primary_ingredients: primaryIngredients, saved_at: new Date().toISOString(),
        }).select().single()
        if (!error && data) setToMake(prev => [dbToMakeToLocal(data), ...prev])
      }
    } else {
      setToMake(prev => {
        const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
        if (existing >= 0) return prev.filter((_, i) => i !== existing)
        return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, instructions: res.instructions || null, ingredients: res.ingredients, variations: res.variations, glassType: res.glass_type || null, source, originFlag, difficulty, primaryIngredients, savedAt: new Date().toISOString() }, ...prev]
      })
    }
  }

  const removeFromToMake = async (id) => {
    if (user) await supabase.from('to_make').delete().eq('id', id)
    setToMake(prev => prev.filter(f => f.id !== id))
  }

  // In the Lab helpers
  const toggleInTheLab = async (res, extras = {}) => {
    const { source = 'manual', originFlag = null, difficulty = null, primaryIngredients = [] } = extras
    if (user) {
      const existing = inTheLabList.find(f => f.recipeName === res.recipe_name)
      if (existing) {
        await supabase.from('in_the_lab').delete().eq('id', existing.id)
        setInTheLabList(prev => prev.filter(f => f.id !== existing.id))
      } else {
        try {
          const { data, error } = await supabase.from('in_the_lab').insert({
            user_id: user.id, recipe_name: res.recipe_name, summary: res.summary || null,
            recipe: res.recipe || [], instructions: res.instructions || null,
            ingredients: res.ingredients || [], variations: res.variations || [],
            glass_type: res.glass_type || null, source, origin_flag: originFlag,
            difficulty, primary_ingredients: primaryIngredients, tried: false, saved_at: new Date().toISOString(),
          }).select().single()
          if (!error && data) setInTheLabList(prev => [dbInTheLabToLocal(data), ...prev])
        } catch (_) {}
      }
    } else {
      setInTheLabList(prev => {
        const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
        if (existing >= 0) return prev.filter((_, i) => i !== existing)
        return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, instructions: res.instructions || null, ingredients: res.ingredients, variations: res.variations, glassType: res.glass_type || null, source, originFlag, difficulty, primaryIngredients, savedAt: new Date().toISOString() }, ...prev]
      })
    }
  }

  const removeFromInTheLab = async (id) => {
    if (user) { try { await supabase.from('in_the_lab').delete().eq('id', id) } catch (_) {} }
    setInTheLabList(prev => prev.filter(f => f.id !== id))
  }

  const toggleLabTried = async (id, tried) => {
    setInTheLabList(prev => prev.map(i => i.id === id ? { ...i, tried } : i))
    setCurrentLabItem(prev => prev?.id === id ? { ...prev, tried } : prev)
    if (user) { try { await supabase.from('in_the_lab').update({ tried }).eq('id', id) } catch (_) {} }
  }

  const updateLabNotes = async (id, notes) => {
    setInTheLabList(prev => prev.map(i => i.id === id ? { ...i, note: notes } : i))
    setCurrentLabItem(prev => prev?.id === id ? { ...prev, note: notes } : prev)
    if (user) { try { await supabase.from('in_the_lab').update({ notes }).eq('id', id) } catch (_) {} }
  }

  const saveLabToFavorites = async (item) => {
    const alreadyFav = favorites.some(f => f.recipeName === item.recipeName)
    if (!alreadyFav) {
      await toggleFavorite({ recipe_name: item.recipeName, summary: item.summary, recipe: item.recipe, instructions: item.instructions, ingredients: item.ingredients, variations: item.variations, glass_type: item.glassType }, { source: item.source })
    }
    await removeFromInTheLab(item.id)
    handleBackToSource()
  }

  const revertLabTweak = async (item) => {
    const revertedLabItem = {
      ...item,
      recipe: item.originalRecipe || [],
      instructions: item.originalInstructions || null,
      summary: item.originalSummary || null,
      glassType: item.originalGlassType || null,
      originalRecipe: null, originalInstructions: null,
      originalSummary: null, originalGlassType: null,
    }
    if (user) {
      try {
        await supabase.from('in_the_lab').update({
          recipe: item.originalRecipe || [],
          instructions: item.originalInstructions || null,
          summary: item.originalSummary || null,
          glass_type: item.originalGlassType || null,
          original_recipe: null, original_instructions: null,
          original_summary: null, original_glass_type: null,
        }).eq('id', item.id)
      } catch (_) {}
    }
    setCurrentLabItem(revertedLabItem)
    setInTheLabList(prev => prev.map(i => i.id === item.id ? revertedLabItem : i))
    setResult(prev => ({
      ...prev,
      recipe: item.originalRecipe || [],
      instructions: item.originalInstructions || null,
      summary: item.originalSummary || null,
      glass_type: item.originalGlassType || null,
    }))
    setAdjustmentNote(null)
  }

  const viewToMake = (item) => {
    sourceScrollRef.current = window.scrollY
    setError(null); setAdjustmentNote(null)
    setResult({ recipe_name: item.recipeName, summary: item.summary, recipe: item.recipe, instructions: item.instructions, ingredients: item.ingredients, variations: item.variations, glass_type: item.glassType })
    setResultSource('ondeck')
    setScreen('analyze')
  }

  const viewFavorite = (fav) => {
    sourceScrollRef.current = window.scrollY
    setError(null); setAdjustmentNote(null)
    setResult({ recipe_name: fav.recipeName, summary: fav.summary, recipe: fav.recipe, instructions: fav.instructions, ingredients: fav.ingredients, variations: fav.variations, glass_type: fav.glassType })
    setResultSource('favorites')
    setScreen('analyze')
  }

  const viewInTheLab = (item) => {
    sourceScrollRef.current = window.scrollY
    setError(null); setAdjustmentNote(null)
    setCurrentLabItem(item)
    setResult({ recipe_name: item.recipeName, summary: item.summary, recipe: item.recipe, instructions: item.instructions, ingredients: item.ingredients, variations: item.variations, glass_type: item.glassType })
    setResultSource('inthelab')
    setLastRequestBody({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: 'Please analyze this cocktail recipe.' }] })
    setScreen('analyze')
  }

  const signIn = () => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })
  const signOut = () => supabase.auth.signOut()

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
    setLoading(true); setError(null); setResult(null); setAdjustmentNote(null); setResultSource(null)
    const menuParseStep = mode === 'menu' && menuStep === 'upload'
    setLoadingMsg(menuParseStep ? 'Reading menu…' : mode === 'photo' ? 'Analyzing screenshot…' : mode === 'name' ? 'Looking up cocktail…' : 'Analyzing cocktail…')

    try {
      if (menuParseStep) {
        const parsed = await parseMenuCocktails(menuPhoto)
        setMenuCocktails(Array.isArray(parsed?.cocktails) ? parsed.cocktails : [])
        setMenuStep('selecting')
        setLoading(false)
        return
      }
      let response
      if (mode === 'photo') {
        response = await analyzeRecipePhoto(recipePhoto, inventoryText)
      } else if (mode === 'name') {
        const name = cocktailName.trim()
        const makeTimeout = () => new Promise((_, reject) =>
          setTimeout(() => reject(new Error('__timeout__')), 60000)
        )
        try {
          response = await Promise.race([analyzeCocktailName(name, inventoryText), makeTimeout()])
        } catch (firstErr) {
          console.error('Error details:', firstErr, typeof firstErr)
          // On timeout or any failure, fall back to training data (no web search)
          try {
            response = await analyzeCocktailNameTrainingOnly(name, inventoryText)
          } catch (fallbackErr) {
            console.error('Error details:', fallbackErr, typeof fallbackErr)
            // If even the fallback fails, surface a clean error message
            const isTimeout = firstErr?.message === '__timeout__'
            throw new Error(isTimeout
              ? 'The search took too long. Try again or check if the cocktail name is spelled correctly.'
              : (firstErr?.message || 'Something went wrong. Please try again.'))
          }
        }
      } else {
        response = await analyzeBarMenu(menuPhoto, menuSelectedCocktail, inventoryText, menuCocktailPhoto)
      }
      setLastRequestBody(response.body)
      setResult(processResult(response.data))
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const stripInventoryFromMessages = (messages) =>
    messages.map((msg, i) => {
      if (i !== 0 || msg.role !== 'user') return msg
      const strip = (text) => text.replace(
        /(BAR INVENTORY:\n)[\s\S]*?(\n\nSHELF LIFE GUIDANCE)/,
        '$1[Inventory data omitted for brevity — use the analysis already provided]$2'
      )
      if (typeof msg.content === 'string') return { ...msg, content: strip(msg.content) }
      if (Array.isArray(msg.content)) return {
        ...msg,
        content: msg.content.map(part => part.type === 'text' ? { ...part, text: strip(part.text) } : part),
      }
      return msg
    })

  const handleFeedback = async (feedbackText) => {
    if (!lastRequestBody || !result) return
    setFeedbackLoading(true); setError(null)
    try {
      const feedbackBody = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          ...stripInventoryFromMessages(lastRequestBody.messages),
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: `The user reviewed this analysis and provided this feedback: ${feedbackText}. Please revise your response accordingly and return the same JSON structure, with one additional field at the top level: "adjustment_note" — a 1-2 sentence plain English explanation of what specifically changed and why (e.g. "Scaled all amounts to a 4 oz total while maintaining the 1:1:1 Negroni ratio."). Do not include adjustment_note if nothing meaningful changed.` },
        ],
      }
      const revised = await callClaude(feedbackBody)
      setLastRequestBody(feedbackBody)
      setAdjustmentNote(revised.adjustment_note || null)
      setError(null)

      if (resultSource === 'inthelab' && currentLabItem) {
        const needsSnapshot = !currentLabItem.originalRecipe
        const updateData = {
          recipe: revised.recipe || [],
          instructions: revised.instructions || null,
          summary: revised.summary || null,
          glass_type: revised.glass_type || null,
          ...(needsSnapshot ? {
            original_recipe: result.recipe || [],
            original_instructions: result.instructions || null,
            original_summary: result.summary || null,
            original_glass_type: result.glass_type || null,
          } : {}),
        }
        if (user) { try { await supabase.from('in_the_lab').update(updateData).eq('id', currentLabItem.id) } catch (_) {} }
        const updatedLabItem = {
          ...currentLabItem,
          recipe: revised.recipe || [],
          instructions: revised.instructions || null,
          summary: revised.summary || null,
          glassType: revised.glass_type || null,
          ...(needsSnapshot ? {
            originalRecipe: result.recipe || [],
            originalInstructions: result.instructions || null,
            originalSummary: result.summary || null,
            originalGlassType: result.glass_type || null,
          } : {}),
        }
        setCurrentLabItem(updatedLabItem)
        setInTheLabList(prev => prev.map(i => i.id === currentLabItem.id ? updatedLabItem : i))
      }

      setResult(processResult(revised))
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setFeedbackLoading(false)
    }
  }

  const changeMode = (m) => {
    setMode(m); setResult(null); setError(null); setLastRequestBody(null); setResultSource(null)
    setMenuPhoto(null); setMenuStep('upload'); setMenuCocktails([]); setMenuSelectedCocktail(''); setMenuCocktailPhoto(null)
  }

  const handleBackToSource = () => {
    const src = resultSource
    const savedScroll = sourceScrollRef.current
    setResultSource(null)
    setResult(null)
    setSavedSubTab(src) // 'ondeck' | 'inthelab' | 'favorites'
    setScreen('saved')
    requestAnimationFrame(() => window.scrollTo(0, savedScroll))
  }

  const MODES = [
    { id: 'photo', label: '📷 Recipe Screenshot' },
    { id: 'name', label: '⌨️ Cocktail Name' },
    { id: 'menu', label: '🍹 Bar Menu' },
  ]

  const analysisModeSource = mode === 'photo' ? 'Recipe Screenshot' : mode === 'name' ? 'Cocktail Name' : 'Bar Menu'

  const inventoryText = inventory ? inventoryToText(inventory) : ''

  const handleSaveOnDeckFromExploration = (suggestion, primaryIngredients) => {
    toggleToMake({ recipe_name: suggestion.recipe_name, summary: suggestion.summary, recipe: suggestion.recipe, instructions: suggestion.instructions, ingredients: suggestion.ingredients, variations: suggestion.variations || [], glass_type: suggestion.glass_type }, { source: 'Exploration', originFlag: suggestion.origin_flag, difficulty: suggestion.difficulty, primaryIngredients })
  }

  const handleSaveInTheLabFromExploration = (suggestion, primaryIngredients) => {
    toggleInTheLab({ recipe_name: suggestion.recipe_name, summary: suggestion.summary, recipe: suggestion.recipe, instructions: suggestion.instructions, ingredients: suggestion.ingredients, variations: suggestion.variations || [], glass_type: suggestion.glass_type }, { source: 'Exploration', originFlag: suggestion.origin_flag, difficulty: suggestion.difficulty, primaryIngredients })
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 20px 110px' }}>

      {/* Header */}
      <div style={{ padding: '24px 0 18px', borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div onClick={() => setScreen('analyze')} style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.04em', color: C.gold, cursor: 'pointer' }}>Bar Cart</div>
            <div style={{ fontSize: 13, color: C.textFaint, marginTop: 2 }}>home cocktail assistant</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!authLoading && (user ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {user.user_metadata?.avatar_url ? (
                  <img src={user.user_metadata.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%', border: `1px solid ${C.border}` }} />
                ) : (
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: C.gold + '33', border: `1px solid ${C.gold}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: C.gold }}>
                    {(user.user_metadata?.full_name || user.email || '?')[0].toUpperCase()}
                  </div>
                )}
                <button onClick={signOut} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}>Sign out</button>
              </div>
            ) : (
              <button onClick={signIn} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, fontSize: 12, fontWeight: 600, padding: '5px 9px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <svg width="13" height="13" viewBox="0 0 18 18" style={{ flexShrink: 0 }}><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.259c-.806.54-1.837.86-3.047.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>
                Sign in
              </button>
            ))}
            <button onClick={() => setScreen(s => s === 'settings' ? 'analyze' : 'settings')} title="Settings"
              style={{ background: screen === 'settings' ? C.gold + '22' : 'none', border: `1px solid ${screen === 'settings' ? C.gold + '55' : 'transparent'}`, borderRadius: 8, color: screen === 'settings' ? C.gold : C.textMuted, fontSize: 20, lineHeight: 1, padding: '6px 8px', cursor: 'pointer', transition: 'color 0.15s, background 0.15s' }}>
              ⚙️
            </button>
          </div>
        </div>
      </div>

      {/* Share target mode prompt */}
      {sharedImage && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>What is this a photo of?</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 24 }}>Choose how to use this image:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button onClick={() => { setMode('photo'); setRecipePhoto(sharedImage); setSharedImage(null); setScreen('analyze') }}
              style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, padding: '20px 16px', fontSize: 17, fontWeight: 600, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.background = C.gold + '12' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.surface }}>
              <span style={{ fontSize: 32, lineHeight: 1 }}>📷</span>
              <div><div>Recipe Screenshot</div><div style={{ fontSize: 13, fontWeight: 400, color: C.textMuted, marginTop: 3 }}>A screenshot or photo of a cocktail recipe</div></div>
            </button>
            <button onClick={() => { setMode('menu'); setMenuPhoto(sharedImage); setMenuStep('upload'); setSharedImage(null); setScreen('analyze') }}
              style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, padding: '20px 16px', fontSize: 17, fontWeight: 600, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.background = C.gold + '12' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.surface }}>
              <span style={{ fontSize: 32, lineHeight: 1 }}>🍹</span>
              <div><div>Bar Menu</div><div style={{ fontSize: 13, fontWeight: 400, color: C.textMuted, marginTop: 3 }}>A photo of a cocktail menu at a bar or restaurant</div></div>
            </button>
          </div>
        </div>
      )}

      {/* Screen: Settings */}
      {screen === 'settings' && (
        <SettingsScreen sheetUrlInput={sheetUrlInput} setSheetUrlInput={setSheetUrlInput} onReload={handleReload} inventoryLoading={inventoryLoading} inventoryError={inventoryError} inventory={inventory} inStockCount={inStockCount} oosCount={oosCount} />
      )}

      {/* Screen: Inventory */}
      {screen === 'inventory' && (
        <InventoryScreen inventory={inventory} inStockCount={inStockCount} oosCount={oosCount} />
      )}

      {/* Screen: Shopping */}
      {screen === 'shopping' && (
        <ShoppingListScreen shoppingList={shoppingList} onRemove={removeFromShopping} onClear={clearShopping} />
      )}

      {/* Screen: Saved */}
      {screen === 'saved' && (
        <SavedScreen
          savedSubTab={savedSubTab} setSavedSubTab={setSavedSubTab}
          toMake={toMake} inTheLabList={inTheLabList} favorites={favorites}
          onRemoveToMake={removeFromToMake} onRemoveInTheLab={removeFromInTheLab} onRemoveFavorite={removeFavorite}
          onViewToMake={viewToMake} onViewInTheLab={viewInTheLab} onViewFavorite={viewFavorite}
          onUpdateNote={updateFavoriteNote}
        />
      )}

      {/* Screen: Explorations */}
      {screen === 'explorations' && (
        <ExplorationsScreen
          inventory={inventory}
          inventoryText={inventoryText}
          onSaveOnDeck={handleSaveOnDeckFromExploration}
          onSaveInTheLab={handleSaveInTheLabFromExploration}
          user={user}
        />
      )}

      {/* Screen: Analyze */}
      {screen === 'analyze' && (
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
            {mode === 'photo' && <UploadZone file={recipePhoto} onFile={setRecipePhoto} onRemove={() => setRecipePhoto(null)} />}
            {mode === 'name' && (
              <input type="text" value={cocktailName} onChange={e => setCocktailName(e.target.value)} onKeyDown={e => e.key === 'Enter' && canAnalyze() && handleAnalyze()} placeholder="e.g. Naked and Famous" autoFocus
                style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, padding: '14px 16px', fontSize: 16, outline: 'none' }} />
            )}
            {mode === 'menu' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {menuStep === 'upload' && <UploadZone file={menuPhoto} onFile={setMenuPhoto} onRemove={() => setMenuPhoto(null)} />}
                {(menuStep === 'selecting' || menuStep === 'ready') && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 13, color: C.textMuted }}>{menuCocktails.length} cocktail{menuCocktails.length !== 1 ? 's' : ''} found — tap one to select</div>
                      <button onClick={() => { setMenuStep('upload'); setMenuCocktails([]); setMenuSelectedCocktail(''); setMenuCocktailPhoto(null) }} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0 }}>← new menu</button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {menuCocktails.map(name => {
                        const sel = name === menuSelectedCocktail
                        return <button key={name} onClick={() => { setMenuSelectedCocktail(name); setMenuStep('ready'); setResult(null); setError(null) }} style={{ background: sel ? C.gold : C.surface, border: `1px solid ${sel ? C.gold : C.border}`, borderRadius: 20, color: sel ? '#0f0f0f' : C.text, fontSize: 13, fontWeight: sel ? 700 : 400, padding: '6px 14px', cursor: 'pointer', transition: 'background 0.15s, color 0.15s' }}>{name}</button>
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
                              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { if (e.target.files[0]) setMenuCocktailPhoto(e.target.files[0]) }} />
                              <span style={{ fontSize: 18 }}>🍸</span>Click to add cocktail photo
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

          <button onClick={handleAnalyze} disabled={!canAnalyze()}
            style={{ width: '100%', background: canAnalyze() ? C.gold : C.surface, border: `1px solid ${canAnalyze() ? C.gold : C.border}`, borderRadius: 10, color: canAnalyze() ? '#0f0f0f' : C.textFaint, fontWeight: 700, fontSize: 15, padding: '13px', cursor: canAnalyze() ? 'pointer' : 'default', transition: 'background 0.15s, color 0.15s, border-color 0.15s' }}>
            {loading ? loadingMsg : 'Analyze'}
          </button>

          {error && <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.red, marginTop: 16 }}>{error}</div>}

          {loading && (
            <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 14, marginTop: 32, padding: '24px 0' }}>
              <style>{`@keyframes bcspin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ display: 'inline-block', width: 30, height: 30, border: `3px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'bcspin 0.75s linear infinite', marginBottom: 12 }} />
              <div>{loadingMsg}</div>
            </div>
          )}

          {result && !loading && (
            <>
              {resultSource && (
                <button onClick={handleBackToSource} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0 0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  ← Back to {resultSource === 'ondeck' ? 'On Deck' : resultSource === 'inthelab' ? 'In the Lab' : 'Favorites'}
                </button>
              )}
              <Results
                result={result}
                adjustmentNote={adjustmentNote}
                shoppingList={shoppingList}
                onAddToList={addToShopping}
                favorites={favorites}
                onToggleFavorite={res => toggleFavorite(res, { source: analysisModeSource })}
                toMake={toMake}
                onToggleToMake={res => toggleToMake(res, { source: analysisModeSource })}
                inTheLabList={inTheLabList}
                onToggleInTheLab={res => toggleInTheLab(res, { source: analysisModeSource })}
                onFeedback={handleFeedback}
                feedbackLoading={feedbackLoading}
                inventory={inventory}
                isInLab={resultSource === 'inthelab'}
                labItem={resultSource === 'inthelab' ? currentLabItem : null}
                onMarkTried={toggleLabTried}
                onSaveLabToFavorites={saveLabToFavorites}
                onUpdateLabNotes={updateLabNotes}
                onArchiveFromLab={(id) => { removeFromInTheLab(id); handleBackToSource() }}
                onRevertLabTweak={revertLabTweak}
              />
            </>
          )}
        </>
      )}

      <BottomTabBar screen={screen} onTab={setScreen} />
    </div>
  )
}
