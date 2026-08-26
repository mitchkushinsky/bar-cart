// SUPABASE MIGRATION REQUIRED (run in Supabase SQL editor):
// create table if not exists explorations_history (
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid references auth.users not null,
//   search_key text not null,
//   primary_ingredients text[] not null default '{}',
//   low_abv boolean not null default false,
//   result jsonb not null,
//   updated_at timestamptz default now(),
//   unique(user_id, search_key)
// );
// alter table explorations_history enable row level security;
// create policy "Users own their explorations history" on explorations_history for all using (auth.uid() = user_id);
//
// Template picker reset (Pass 1 of 2): style is retired as a user-facing concept —
// technique is now an output of the chosen template, not an input. Run against the
// existing explorations_history table:
// alter table explorations_history drop column if exists cocktail_style;
// alter table explorations_history add column if not exists template text;
//
// Template picker (Pass 2): Flavor Profile is retired as a user input — flavor is now
// an output the generator describes in each suggestion's summary, not a constraint the
// user picks. Frozen/NA join Low-ABV as the three modifier chips. Run against the
// existing explorations_history table:
// alter table explorations_history drop column if exists flavor_profile;
// alter table explorations_history add column if not exists frozen boolean default false;
// alter table explorations_history add column if not exists na boolean default false;
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
// Session 3d: origin (published/riff/original) never persisted past the exploration —
// only the legacy two-way origin_flag did. New rows only; no backfill of existing data.
// alter table favorites add column if not exists origin text;
// alter table to_make add column if not exists origin text;
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
//
// create table if not exists exploration_whiteboards (
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid references auth.users not null,
//   title text not null,
//   status text not null default 'active',
//   last_touched_at timestamptz default now(),
//   created_at timestamptz default now()
// );
// alter table exploration_whiteboards enable row level security;
// create policy "Users own their whiteboards" on exploration_whiteboards for all using (auth.uid() = user_id);
//
// create table if not exists exploration_nodes (
//   id uuid default gen_random_uuid() primary key,
//   whiteboard_id uuid references exploration_whiteboards not null,
//   parent_node_id uuid references exploration_nodes,
//   node_type text not null,
//   payload jsonb not null default '{}',
//   notes text,
//   created_at timestamptz default now()
// );
// alter table exploration_nodes enable row level security;
// create policy "Users own their nodes" on exploration_nodes for all using (
//   auth.uid() = (select user_id from exploration_whiteboards where id = whiteboard_id)
// );
//
// Session 4: inventory semantic tagging. generic_type + aliases per bottle,
// keyed by the inventory item's name (trimmed, lowercased) so a rename in the
// source spreadsheet naturally orphans the old tag row — the renamed bottle
// resurfaces as untagged on the next load rather than silently keeping a
// stale tag. Shared, not user-scoped, same as ingredient_affinities: no RLS,
// the tagging endpoint writes with the service-role key, the client reads
// and manually-edits with the anon key.
// create table if not exists inventory_tags (
//   item_name text primary key,
//   generic_type text not null,
//   aliases jsonb not null default '[]',
//   tagged_at timestamptz default now()
// );

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
  // Session 5: dedicated to the "missing" ownership status specifically — the
  // general-purpose C.red (error banners, expired badges) reads too close to
  // amber at dot size, and missing is the one status that costs money, so it
  // gets its own louder, more saturated red rather than reusing C.red globally.
  missing: '#ff4d4d',
  blue: '#5090d8',
  text: '#f0ede8',
  textMuted: '#888',
  textFaint: '#555',
}

// ─── Cocktail Templates ─────────────────────────────────────────────────────
// Fixed display order — do not sort dynamically. Groups structurally similar
// templates adjacently (stirred spirit-forward → shaken citrus → lengthened →
// specialized tail) so the order becomes learnable over repeated use.

const TEMPLATES = [
  { id: 'old_fashioned', name: 'Old Fashioned', emoji: '🥃', subtitle: 'like an Old Fashioned',
    formula: 'usually 2 oz spirit : 0.25 oz rich syrup : bitters',
    mechanic: 'Stirred. Softens spirit heat without masking core spirit identity.',
    examples: ['Sazerac', "Ti' Punch", 'Monte Carlo', 'Oaxaca Old Fashioned'], frozenEligible: false },
  { id: 'manhattan_martini', name: 'Manhattan / Martini', emoji: '🍸', subtitle: 'like a Manhattan',
    formula: 'usually 2 oz spirit : 1 oz fortified wine : bitters',
    mechanic: 'Stirred. Silky, spirit-driven texture using vermouth/fortified wine as the sweetener.',
    examples: ['Dry Martini', 'Martinez', 'Rob Roy', 'Bamboo', 'Adonis'], frozenEligible: false },
  { id: 'sour', name: 'Sour', emoji: '🍋', subtitle: 'like a Daiquiri',
    formula: 'usually 2 oz spirit : 0.75 oz acid : 0.75 oz simple syrup — equal-parts variants swap the syrup for a second liqueur',
    mechanic: 'Shaken. Aerated citrus and sugar balance.',
    examples: ['Whiskey Sour', 'Gimlet', "Bee's Knees", 'Gold Rush', 'Last Word', 'Paper Plane', 'Naked & Famous', 'Division Bell', 'Final Ward'], frozenEligible: true },
  { id: 'daisy', name: 'Daisy', emoji: '🌼', subtitle: 'like a Margarita',
    formula: 'usually 2 oz spirit : 0.75 oz acid : 0.75 oz liqueur',
    mechanic: 'Shaken. Fruit or botanical liqueur replaces simple syrup, contributing both sweetness and modifier flavor.',
    examples: ['Sidecar', 'Cosmopolitan', 'White Lady', 'Aviation'], frozenEligible: true },
  { id: 'highball', name: 'Highball', emoji: '🫧', subtitle: 'like a Tom Collins',
    formula: 'usually 1.5–2 oz spirit : 0.75 oz acid : 0.75 oz sweet : soda',
    mechanic: 'Built over ice. Lengthens sours or spirits with refreshing carbonation.',
    examples: ['Paloma', 'Moscow Mule', "Dark 'n Stormy", 'Gin & Tonic', 'Mojito'], frozenEligible: false },
  { id: 'tiki', name: 'Tiki', emoji: '🌺', subtitle: 'like a Mai Tai',
    formula: 'usually 2 oz split rum : 0.75 oz lime : 0.75 oz layered syrups/liqueurs',
    mechanic: 'Flash-blended or swizzled. Multi-spirit layering with complex spice syrups and heavy ice dilution.',
    examples: ['Zombie', 'Navy Grog', 'Painkiller', 'Saturn', 'Jet Pilot'], frozenEligible: true },
  { id: 'bittersweet', name: 'Bittersweet', emoji: '🧡', subtitle: 'like a Negroni',
    formula: 'usually 1 oz spirit : 1 oz bittersweet aperitivo : 1 oz sweet vermouth',
    mechanic: 'Stirred. High liqueur sugar content balances intense bitterness without citrus acid.',
    examples: ['Boulevardier', 'Kingston Negroni', 'Old Pal', 'Lucien Gaudin'], frozenEligible: false },
  { id: 'spritz', name: 'Spritz', emoji: '🥂', subtitle: 'like an Aperol Spritz',
    formula: 'usually 3 oz prosecco : 2 oz aperitivo : 1 oz soda water',
    mechanic: 'Built. Low-ABV effervescence; wine acidity replaces fresh citrus juice.',
    examples: ['Venetian Spritz', 'Hugo Spritz', 'St-Germain Spritz', 'Bicicletta'], frozenEligible: false },
  { id: 'hot_drinks', name: 'Hot Drinks', emoji: '☕', subtitle: 'like a Hot Toddy',
    formula: 'usually 2 oz spirit : 0.5–0.75 oz sweet : 3–4 oz hot diluent + acid',
    mechanic: 'Built hot. Heat enhances aromatic volatiles while hot liquid provides controlled dilution.',
    examples: ['Irish Coffee', 'Hot Buttered Rum', 'Mulled Wine'], frozenEligible: false },
  { id: 'flip', name: 'Flip', emoji: '🥚', subtitle: 'like a Brandy Flip',
    formula: 'usually 2 oz spirit/wine : 0.5–0.75 oz syrup : 1 whole egg',
    mechanic: 'Dry shaken. Emulsified egg fat and protein yield a rich dessert finish with zero citrus.',
    examples: ['Sherry Flip', 'Port Flip', 'Rum Flip'], frozenEligible: false },
]
const TEMPLATE_MAP = Object.fromEntries(TEMPLATES.map(t => [t.id, t]))

// Per-ingredient functional role, self-reported by the model on every tier-2/3
// suggestion's recipe array (see analyzeExplorationsOriginals). "citrus" means citrus
// juice used structurally — a peel/twist garnish is role "garnish", never "citrus".
const RECIPE_ROLES = ['base', 'citrus', 'sweetener', 'modifier', 'bitters', 'lengthener', 'egg', 'dairy', 'garnish']
const ROLE_LABELS = {
  base: 'a base spirit',
  citrus: 'fresh citrus juice',
  sweetener: 'a sweetening element (syrup/sugar)',
  modifier: 'a modifying element (vermouth, liqueur, or bitter aperitivo)',
  bitters: 'bitters',
  lengthener: 'a lengthening element (soda, tonic, or hot liquid)',
  egg: 'a whole egg',
  dairy: 'dairy/cream',
  garnish: 'a garnish',
}

// Each template's structural signature: roles a valid build MUST include, and roles
// it must NEVER include. Deliberately a plain data table (not embedded in prompt
// strings or validation logic) so these are tunable independently of both — expect
// to retune after seeing real generation output, especially Sour vs. Daisy and Spritz.
// Only tier-2 (riff) and tier-3 (original) suggestions are validated against this;
// tier-1 (published) is exempt — see analyzeExplorationsRecipes.
const TEMPLATE_SIGNATURES = {
  old_fashioned: { requiredRoles: ['base', 'sweetener', 'bitters'], forbiddenRoles: ['citrus'] },
  manhattan_martini: { requiredRoles: ['base', 'modifier'], forbiddenRoles: ['citrus'] },
  sour: { requiredRoles: ['base', 'citrus', 'sweetener'], forbiddenRoles: [] },
  daisy: { requiredRoles: ['base', 'citrus', 'modifier'], forbiddenRoles: [] },
  highball: { requiredRoles: ['base', 'lengthener'], forbiddenRoles: [] },
  tiki: { requiredRoles: ['base', 'citrus', 'sweetener', 'modifier'], forbiddenRoles: [] },
  bittersweet: { requiredRoles: ['base', 'modifier'], forbiddenRoles: ['citrus'] },
  spritz: { requiredRoles: ['modifier', 'lengthener'], forbiddenRoles: ['citrus'] },
  hot_drinks: { requiredRoles: ['base', 'sweetener', 'lengthener'], forbiddenRoles: [] },
  flip: { requiredRoles: ['base', 'egg', 'sweetener'], forbiddenRoles: ['citrus'] },
}

// Imperative structural constraint block for tier-2/3 generation (and its regeneration
// pass) only — tier-1 stays on the softer, descriptive buildTemplateContext, since a
// real published recipe is presented as published or not at all, never "corrected."
function buildTemplateConstraint(templateId) {
  const sig = TEMPLATE_SIGNATURES[templateId]
  const t = TEMPLATE_MAP[templateId]
  if (!sig || !t) return ''
  const required = sig.requiredRoles.map(r => ROLE_LABELS[r] || r).join(', ')
  let block = `TEMPLATE STRUCTURE IS MANDATORY, NOT A SUGGESTION: every suggestion MUST include, among its recipe ingredients: ${required}.`
  if (sig.forbiddenRoles.length > 0) {
    const forbidden = sig.forbiddenRoles.map(r => ROLE_LABELS[r] || r).join(', ')
    block += ` It must NEVER include: ${forbidden} — a ${t.name} does not have that. (A citrus peel/twist used only as garnish is fine — that's role "garnish", not "citrus".)`
  }
  block += ` If the featured ingredients cannot honestly be built into this structure, return fewer suggestions — even zero — rather than bending the template to fit. Two honest ${t.name}s beat four things that drifted from it.`
  block += ` When a flavored liqueur is doing the sweetening (rather than a plain syrup), label its role "modifier", not "sweetener" — that distinction is what separates a Daisy from a Sour.`
  return block
}

// Structure-only check: are the template's required roles present and forbidden roles
// absent among this suggestion's recipe ingredients? Ratios, glassware, and technique
// are not validated. Returns { valid, violations: [human-readable strings] }.
function validateSuggestionStructure(suggestion, templateId) {
  const sig = TEMPLATE_SIGNATURES[templateId]
  if (!sig) return { valid: true, violations: [] }
  const roles = (suggestion?.recipe || []).map(r => r.role).filter(Boolean)
  const violations = []
  for (const req of sig.requiredRoles) {
    if (!roles.includes(req)) violations.push(`missing required role "${req}" (${ROLE_LABELS[req] || req})`)
  }
  for (const forb of sig.forbiddenRoles) {
    if (roles.includes(forb)) violations.push(`contains forbidden role "${forb}" (${ROLE_LABELS[forb] || forb})`)
  }
  return { valid: violations.length === 0, violations }
}

// Shared between analyzeExplorationsOriginals and regenerateOriginalSuggestion (both
// tier-2/3 only — tier-1 published recipes are exempt) so the scope and voice can't
// drift between the two call sites. Follows the same "only if genuinely worth saying,
// otherwise null, do not force one" pattern already proven by cross_template_suggestion.
const WATCH_OUTS_INSTRUCTION = `For each suggestion, also consider a "watch_outs" note — but only in two specific cases, and only when there's genuinely something worth saying:
1. TEMPLATE DRIFT: the drink is structurally valid but stylistically pulls toward a different, specific classic outside this template's family (e.g. a vodka Manhattan/Martini whose coffee liqueur pulls it toward Black Manhattan territory).
2. AFFINITY CLASH: a specific ingredient pairing likely to fight rather than complement, or one component likely to dominate and flatten the others.
Do NOT use it for anything the template already conveys, anything visible in the ingredient list, technique difficulty (difficulty_note already covers that), or generic hedging like "adjust to taste." Most suggestions should get null — a watch-out means something because it's uncommon; if you find yourself writing one for nearly every suggestion, you're being too permissive. Voice: terse, direct, expert — like a colleague saying "heads up, the Cynar is going to fight the Carpano here," not a disclaimer. No affirmations, no hedging, no apology. Set "watch_outs" to null (not omitted) when there's nothing worth flagging.`

// Shared between analyzeExplorationsOriginals and regenerateOriginalSuggestion. The
// failure mode this guards against: treating "generate riffs" as an enumeration task
// (every constructible bottle swap) instead of a judgment task (only the swaps that
// actually change the drink). Points 1-2 apply to any single riff/original; points
// 3-4 (batch-only distinctness and the hard cap) are appended separately where a full
// batch is being generated, not for a single corrective regeneration.
const RIFF_DISCIPLINE_CORE = `RIFF DISCIPLINE — a riff is a judgment call, not an enumeration:
1. MEANINGFUL SWAPS ONLY. A same-category, different-producer substitution is not a riff — Rittenhouse where a recipe calls for Sazerac Rye is the same drink, not a new one; that belongs to substitution/annotation, not generation. The test: does this swap change the drink enough that it would need its own name? Cynar for sweet vermouth in a Manhattan is a different drink. Carpano for Punt e Mes is a preference.
2. AT MOST TWO REPLACEMENTS from the canonical formula. Beyond two, the result is closer to an original than a riff, and the lineage stops being legible.`

const RIFF_DISCIPLINE_BATCH = `${RIFF_DISCIPLINE_CORE}
3. DISTINCTNESS WITHIN THE SET. Two returned riffs that differ only by an interchangeable bottle are one riff — return the better one, not both.
Above all three: generate as many riffs as are genuinely good, not as many as are constructible. Four good riffs beat twelve mechanical ones. If only two are genuinely distinct, two is the honest answer — the same principle as tier-1 returning an empty state rather than stretching.
4. HARD CAP: at most 4 suggestions total in this batch, and fewer whenever fewer are genuinely distinct. This is a ceiling, not a quota — "return 4" is wrong when only 2 are genuinely good. Two good riffs is a correct and complete answer.`

// Session 5: shared verbatim across every prompt that asks the model to set an
// ingredient's "status" and a suggestion's can_make_now, so the two rules can't
// drift out of sync between functions — a drift here would silently desync the
// UI's dot colors from the Can Make Now / Shopping Required split. Mirrors the
// same "product category, not flavor origin" boundary hotfix 9eef91e established
// for tier-1 search matching, applied here to ownership instead of recipe search.
const OWNERSHIP_STATUS_RULES = `OWNERSHIP STATUS — apply this rule identically to every ingredient's "status" field:
- "found": the user owns this ingredient, either under its exact name or as a different producer's bottle of the SAME product type — Rittenhouse satisfies a recipe calling for Sazerac Rye, both are rye whiskey, no purchase needed. Keep the ingredient named as the recipe actually specifies it (e.g. "Sazerac Rye"), not the substitute brand, so the user can see what was intended.
- "substitute": the user does not own this exact product, but owns something — including something makeable from ingredients already on hand, like a syrup — that will genuinely work in its place and still produce a recognizable version of the drink. Populate substitute, substitute_location, and flavor_impact, and be honest in flavor_impact about what changes.
- "missing": the user owns nothing that will work. This ingredient requires a purchase. Never mark an ingredient "missing" while also populating a substitute for it — if a genuine workaround exists from the user's own bottles, that is "substitute," not "missing." Common fresh garnishes (citrus peels, mint, herbs) and pantry staples (sugar, salt, cream, eggs, soda water) are always assumed available and must never be marked "missing."

The found/substitute boundary is PRODUCT CATEGORY, not flavor similarity. Different brands of the same product are interchangeable — found or substitute. Different products that merely share a flavor origin are not, even if the user owns one: maraschino liqueur does not satisfy a cherry liqueur requirement, and cream of coconut does not satisfy a coconut liqueur requirement — different products, a meaningfully different drink, mark these "missing" regardless of what similar-sounding bottle the user owns. Most category-edge cases are softer than that: Campari standing in for a recipe that specifies Forthave Red is a legitimate swap — both are red bitter aperitivos filling the same role — so this is "found" or "substitute" depending on how distinct the two house styles taste, never "missing." Reserve the hard "missing" boundary for genuinely different products, not house-style variation within one category.`

const CAN_MAKE_NOW_RULE = `Set can_make_now: true when every required ingredient OTHER than the featured ingredient(s) is "found" or "substitute" — the user can make a recognizable version of this drink tonight without buying anything. Set it false only when at least one non-featured ingredient is "missing." Judge this honestly for each suggestion on its own; do not aim for a particular mix of true/false results across a batch — if everything is genuinely makeable, every suggestion should say so.`

// Placed adjacent to each prompt's "every featured ingredient must appear"
// requirement, since that is where this carve-out and that requirement would
// otherwise sit with no boundary between them.
const SEED_INGREDIENT_EXEMPT = `The featured ingredient(s) are OUT OF SCOPE for ownership classification. The user chose to explore this ingredient deliberately and already knows whether they own it — it must never be the reason a suggestion is marked can_make_now: false, and it must never be the ingredient that lands a drink in the shopping-required bucket. Still report the featured ingredient's own "status" honestly in the ingredients list — the user can see whether they own it there — but exclude it entirely from the can_make_now determination: only a missing NON-featured ingredient can make can_make_now false.`

// Riffs are the middle rung of the ladder and should lead within each ownership
// section (Can Make Now / Shopping Required) — published items are already tier-1-first
// by construction, so ranking them 0 just preserves that; this exists to fix riff-vs-
// original ordering, which the model doesn't reliably emit in generation order.
const ORIGIN_RANK = { published: 0, riff: 1, original: 2 }
function sortByOriginRank(suggestions) {
  return [...suggestions].sort((a, b) => (ORIGIN_RANK[a?.origin] ?? 3) - (ORIGIN_RANK[b?.origin] ?? 3))
}

const NA_KEYWORDS = ['cucumber', 'mint', 'grapefruit', 'ginger', 'lemongrass', 'lime', 'lemon', 'juice', 'soda', 'tonic', 'syrup', 'tea']
function isLikelyNonAlcoholic(name, inventory) {
  const norm = name.trim().toLowerCase()
  const item = (inventory || []).find(i => i.spirit.trim().toLowerCase() === norm)
  if (item?.category) {
    const cat = item.category.toLowerCase()
    // Any other matched inventory category (spirit/liqueur/vermouth/amaro) is alcoholic.
    return cat.includes('syrup') || cat.includes('juice') || cat.includes('soda') || cat.includes('bitters') || cat.includes('garnish') || cat.includes('non alcohol')
  }
  // Free-text, unmatched — default to hiding NA (i.e. assume alcoholic) unless clearly NA.
  // Never silently propose deleting an ingredient the user just chose as the exploration's premise.
  return NA_KEYWORDS.some(k => norm.includes(k))
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

// Session 5: generic_type/aliases (Session 4's inventory_tags) ride alongside
// category in the same block, so the model can match a recipe's generic ask
// ("rye whiskey") against the user's specifically-named bottles without
// re-deriving the equivalence itself. category is untouched — both fields ship
// together and do different jobs. An untagged bottle just gets blank columns
// here and falls back to name matching, same as before Session 4 existed.
function inventoryToText(items, tags = {}) {
  const lines = ['Spirit | Location | Sub Location | Category | Generic Type | Aliases | Date Opened | Status | Notes']
  for (const item of items) {
    const tag = tags[item.spirit.trim().toLowerCase()]
    const genericType = tag?.generic_type || ''
    const aliases = tag?.aliases?.length > 0 ? tag.aliases.join(', ') : ''
    lines.push(
      `${item.spirit} | ${item.location} | ${item.subLocation} | ${item.category} | ${genericType} | ${aliases} | ${item.dateOpened || 'N/A'} | ${item.oos ? 'OOS' : 'Available'} | ${item.notes}`
    )
  }
  return lines.join('\n')
}

// ─── Claude API ───────────────────────────────────────────────────────────────

function stripInternalFields(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of Object.keys(obj)) if (!k.startsWith('__')) out[k] = obj[k]
  return out
}

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

${OWNERSHIP_STATUS_RULES}

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

function buildTemplateContext(templateId, modifiers) {
  const t = TEMPLATE_MAP[templateId]
  let block = `CHOSEN TEMPLATE: ${t.name}
Usual formula: ${t.formula}
Mechanic: ${t.mechanic}
Classic examples: ${t.examples.join(', ')}

Muddling is a construction step, not a template — if a classic muddled drink structurally belongs to this template (e.g. Mojito→Highball, Whiskey Smash→Sour, Mint Julep→Old Fashioned), treat it normally within the template; never invent a separate "muddled" category.
A split base (two complementary spirits) is a valid output when the inventory and template support it (e.g. Oaxaca Old Fashioned, Mai Tai) — never present it as something the user chose.`
  if (modifiers.frozen) block += `\n\nFROZEN: blend with crushed ice for a frozen/slushy texture appropriate to this template.`
  if (modifiers.lowABV) block += `\n\nLOW ABV: reduce the spirit's proportion relative to the usual formula rather than eliminating it — the spirit should still be present, just lighter. A sherry-and-bitters Old Fashioned is a real drink, not a degraded one.`
  if (modifiers.na) block += `\n\nNON-ALCOHOLIC: without ethanol there is no solvent for aromatics, no viscosity, no burn — build structure from strong tea, verjus, saline, bitter tinctures, and NA spirits rather than simply deleting the spirit. This is genuinely hard on spirit-forward templates (Old Fashioned, Manhattan/Martini, Bittersweet, Flip) — do not produce a result that reads as an apology for missing alcohol.`
  return block
}

// Tier-1 search bias fix: a user-typed ingredient like "muddled cucumber" names
// a preparation, not a product — canonical published recipes list "cucumber"
// as the ingredient and muddling as method, so carrying the prep word into the
// search query and the ingredient-presence check biases the search toward
// blog content titled after its own wording and away from named drinks. Strip
// only this short, conservative list for SEARCH PURPOSES; the raw ingredient
// name (with prep word intact) is preserved everywhere else in the app for
// display, and is still handed to the model as a hint below — muddling is
// real signal toward a Sour/Smash build, not noise to discard.
const PREP_WORDS = new Set(['muddled', 'fresh', 'chilled', 'torched', 'smoked', 'grilled', 'crushed'])
function stripPrepWordsForSearch(name) {
  const kept = name.trim().split(/\s+/).filter(w => !PREP_WORDS.has(w.toLowerCase()))
  const result = kept.join(' ').trim()
  return result || name
}

async function analyzeExplorationsRecipes(ingredients, template, modifiers, inventoryText, excludeNames = []) {
  const t = TEMPLATE_MAP[template]
  const searchIngredients = ingredients.map(stripPrepWordsForSearch)
  const ingredientPhrase = searchIngredients.join(' and ')
  const prepHints = ingredients
    .map((original, i) => ({ original, stripped: searchIngredients[i] }))
    .filter(p => p.stripped.toLowerCase() !== p.original.toLowerCase())
  const prepNote = prepHints.length > 0
    ? `\nPREPARATION NOTE: the user wrote ${prepHints.map(p => `"${p.original}"`).join(' and ')}. Search and match on the underlying ingredient — ${prepHints.map(p => `"${p.stripped}"`).join(', ')} — since published recipes list the ingredient by name, not by prep method. But don't discard the preparation itself: it's a real signal for which drink style to prioritize (e.g. "muddled" points toward a Sour or Smash build rather than an infusion), so let it inform your selection and how you present the result.`
    : ''
  const body = {
    model: MODEL,
    max_tokens: 3000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender. Search the web for PUBLISHED cocktail recipes featuring the featured ingredients, within the family of the chosen template below. Return ONLY real recipes found from published sources — do NOT invent original cocktails. Set origin: "published" for ALL suggestions — every suggestion from this call is an exact published recipe.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}
${prepNote}

${buildTemplateContext(template, modifiers)}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

First check if the featured ingredients fundamentally clash in cocktail contexts. If so, set "incompatible": true and explain briefly in a friendly tone.

Otherwise, scope your web search itself to this template's family — search for terms like "published ${t.name} cocktail recipes with ${ingredientPhrase}" or "${ingredientPhrase} ${t.name} variation," not just "${ingredientPhrase} cocktail" — to find 2–3 published recipes that genuinely belong to this template.

Prefer named, attributable cocktails over generic ingredient-titled recipes when deciding what to return AND what order to return it in. "Eastside," "Southside," "Last Word," "Bee's Knees" — drinks with a real history, a creator, or bar provenance — are the canon; "Cucumber Gin Sour," "Cucumber Gimlet with Rosemary" are recipe-blog content titled after their own ingredient list. Both are legitimate results, but a named drink outranks a generic one, so it goes first. This means searching for named cocktails that CONTAIN these ingredients, not just for recipes DESCRIBED BY these ingredients — a canonical drink's own title frequently does not contain the ingredient words at all (an Eastside's title says nothing about cucumber or gin), which is exactly why a title-keyword-only search misses it and surfaces the blog content instead. If you already know of a well-known drink in this template's family that features these ingredients, search to verify and source it specifically, don't wait for it to surface from a generic search. Where a drink has a known creator, bar, or era, that itself is strong evidence it belongs in the first batch, not a later one.
${excludeNames.length > 0 ? `\nALREADY SURFACED — the user has already seen these recipes, do not return them again, find genuinely different published recipes: ${excludeNames.join(', ')}.\n` : ''}
If a published recipe you find doesn't genuinely belong to this template's family, leave it out of your results rather than including it anyway — never rewrite, restructure, or "correct" a real published recipe to make it fit. A published recipe is presented exactly as published, or not at all.

Search both directions of category and brand for each featured ingredient. If it's a generic category (e.g. "coconut liqueur," "rye whiskey," "blanco tequila"), also search well-known specific products within that category (e.g. Malibu, Kalani, Coco Reàl for coconut liqueur) — published cocktail writing is overwhelmingly brand-specific, so a category-only search under-returns real matches. If it's a specific bottle (e.g. "Clement Mahina Coconut Rhum Liqueur"), also search the generic category term (e.g. "coconut liqueur") — a recipe published for the category is a genuine match for the specific bottle too, and category-level recipes are far more common than ones naming an exact product.

CRITICAL: Every featured ingredient (${searchIngredients.join(', ')}) must appear as an actual ingredient in the recipe's ingredient list — under its own name, a brand name within its category, or the generic category name. A drink that merely shares a flavor or theme with a featured ingredient, without actually containing it, does not satisfy the requirement.

${SEED_INGREDIENT_EXEMPT}

Category and brand are equivalent within the same product kind: a recipe calling for a specific product satisfies a generic category request, and a recipe calling for the generic category — or a different well-known product in that category — satisfies a specific-product request. A distinctive product remains a member of its category regardless of how distinctive it is (e.g. an agricole-based coconut liqueur is still a coconut liqueur); its distinctiveness belongs in the summary as a flavor note, not as grounds to reject other category members as non-matches. This equivalence covers different brands of the SAME product — not every product that merely shares a flavor origin or a source fruit. Maraschino liqueur is not cherry liqueur: despite both being cherry-derived, they are distinct, non-interchangeable products with different production methods and flavor profiles (maraschino is dry and almond-like from crushed cherry pits; cherry liqueur is sweet and fruity) — a recipe calling for one does not satisfy a request for the other.

This equivalence is bound by product kind, not by flavor alone — but "kind" means alcoholic vs. non-alcoholic, not the specific spirit category a product's label files it under. Any alcoholic product built around the featured flavor as its defining character satisfies the requirement, regardless of whether its own label calls it a liqueur, a flavored rum, or something else — Malibu is legally a flavored rum, not a liqueur, but it is still a coconut liqueur for matching purposes here, exactly like Kalani or Clément Mahina. Do not disqualify a product on that technicality. What disqualifies a product is the absence of alcohol: a non-alcoholic product of the same flavor (juice, purée, water, cream, syrup, or milk) never satisfies the requirement, no matter how central it is to the recipe. This is a general rule, not specific to any one flavor: cherry liqueur is not satisfied by cherry juice, coffee liqueur is not satisfied by cold brew, peach liqueur is not satisfied by peach purée, and coconut liqueur is not satisfied by coconut water, coconut purée, cream of coconut, or coconut milk — but coconut liqueur IS satisfied by any alcoholic coconut product, including ones labeled "rum" rather than "liqueur." Do NOT suggest recipes that omit any featured ingredient under this standard — even if fewer results are available as a result.

For each recipe you return, check every non-garnish, non-pantry-staple ingredient against the bar inventory below (note the generic type and aliases listed alongside each bottle — a bottle's generic type or an alias matching an ingredient the recipe calls for means the user owns it).

${OWNERSHIP_STATUS_RULES}

${CAN_MAKE_NOW_RULE}

If you cannot find 2–3 published recipes that include ALL featured ingredients, return as many as you can find (even 0 or 1). If no qualifying published recipes exist, return an empty suggestions array and set "no_recipes_found": true. Do NOT invent original recipes in this call — that is handled separately.

Separately from how many you return, report whether more genuinely exist: set "more_published_exist" to true only if you are aware of ADDITIONAL genuine published recipes for this ingredient/template combination beyond the ones you returned here — not ones you're merely guessing might exist. Setting it false is a specific claim — that no further NAMED, attributable cocktail exists for this combination beyond what you found — not that the batch you're returning merely feels sufficient. If everything in your results is a generic, ingredient-titled recipe rather than a named drink, treat that as evidence more canon likely exists rather than as a sign the search is complete, and lean toward true unless you're genuinely confident nothing else is out there. This doesn't license speculation the other way either: false is still the honest, correct answer whenever it's actually true — the fix is not defaulting to false, not avoiding it. This field must be present on every response, including when no_recipes_found is true (where it should ordinarily be false).

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin, difficulty, difficulty_note, can_make_now, summary, recipe (array of {ingredient, amount, role}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. The summary field should include a short characterization of the drink's flavor profile (e.g. "Bright and citrus-forward with a bitter backbone"), since there is no separate flavor-preference input from the user anymore. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

If — and only if — you are genuinely confident of the recipe's origin (who created it, and where/when), weave that attribution into the summary prose, e.g. "Created by Audrey Saunders at Pegu Club, 2005." Most published recipes don't have a confidently attributable origin — when you don't know, simply don't mention it. Never guess or imply an origin you're not sure of; staying silent is always better than a wrong or invented attribution.

Every entry in each suggestion's "recipe" array must include a "role" field from this fixed enum, describing its functional role in the build: base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish. "citrus" means citrus juice used as a structural component — a citrus peel or twist used only as garnish is role "garnish", not "citrus". Every ingredient in the recipe gets exactly one role.

Separately, check whether these exact featured ingredients are also the basis of a different well-known published drink that belongs to a DIFFERENT template than the one chosen above. Only populate cross_template_suggestion if there's a genuine, well-known match — otherwise leave it null. Do not force one.

Return ONLY valid JSON with no markdown fences:
{
  "incompatible": false,
  "incompatibility_reason": null,
  "no_recipes_found": false,
  "more_published_exist": false,
  "flavor_profile_note": "1-2 sentences on why these ingredients work together",
  "pairs_well_with": "2-3 strongest flavor affinities only — one short sentence, not an exhaustive list",
  "cross_template_suggestion": { "template": "one of: old_fashioned, manhattan_martini, sour, daisy, highball, tiki, bittersweet, spritz, hot_drinks, flip", "drink_name": "string", "reason": "one concise sentence" },
  "suggestions": [
    {
      "recipe_name": "string",
      "origin": "published",
      "difficulty": "easy | medium | hard",
      "difficulty_note": "One sentence explaining difficulty",
      "can_make_now": true,
      "summary": "1-2 sentence description including a flavor characterization",
      "recipe": [{ "ingredient": "string", "amount": "string", "role": "base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish" }],
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
}
cross_template_suggestion must be null (not omitted) when there is no genuine match. more_published_exist must be present (not omitted) on every response.`,
    }],
  }
  const firstText = await callClaudeText(body)
  let data
  try {
    data = extractJSON(firstText)
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
    data = extractJSON(retryText)
  }
  // origin_flag is derived here rather than asked of the model — it's a legacy
  // compatibility field consumed by Favorites/On Deck saves (a real DB column),
  // and every suggestion from this call is always "from_recipe" regardless of
  // the new self-reported origin value, so deriving it guarantees consistency.
  if (data?.suggestions) data.suggestions = data.suggestions.map(s => ({ ...s, origin_flag: 'from_recipe' }))
  // Normalize to a strict boolean rather than trusting the model's JSON literally —
  // anything short of an explicit true is treated as false, so a malformed or omitted
  // field never accidentally shows a CTA the canon can't back up.
  if (data) data.more_published_exist = data.more_published_exist === true
  return data
}

// Single-suggestion regeneration after a template-structure validation failure (Change
// 5). Asks for exactly one corrected suggestion, naming the specific violation, and
// allows the model to honestly decline (return null) rather than force a bad fit.
async function regenerateOriginalSuggestion(ingredients, template, modifiers, inventoryText, failedSuggestion, violations) {
  const t = TEMPLATE_MAP[template]
  const body = {
    model: MODEL,
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender. Your previous suggestion "${failedSuggestion?.recipe_name || 'suggestion'}" violated the ${t?.name || template} template's structure: ${violations.join('; ')}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}

${buildTemplateContext(template, modifiers)}

${buildTemplateConstraint(template)}

BAR INVENTORY:
${inventoryText}

Regenerate ONE corrected cocktail suggestion for the featured ingredients that genuinely fits this template's structure. If no honest fit exists even after correcting for the violation above, return {"suggestion": null} — do not force a bad fit.

Check every non-garnish, non-pantry-staple ingredient against the bar inventory above (note the generic type and aliases listed alongside each bottle — a bottle's generic type or an alias matching an ingredient the recipe calls for means the user owns it).

${SEED_INGREDIENT_EXEMPT}

${OWNERSHIP_STATUS_RULES}

${CAN_MAKE_NOW_RULE}

Set "origin" honestly ("riff" if it's a substitution into the template's usual formula, "original" only as a rare last resort). Every entry in the "recipe" array must include a "role" field from this fixed enum: ${RECIPE_ROLES.join(' | ')}. "citrus" means citrus juice used structurally; a peel/twist garnish is role "garnish".

${RIFF_DISCIPLINE_CORE}

${WATCH_OUTS_INSTRUCTION}

Return ONLY valid JSON, no markdown fences:
{
  "suggestion": {
    "recipe_name": "string",
    "origin": "riff | original",
    "difficulty": "easy | medium | hard",
    "difficulty_note": "string",
    "can_make_now": true,
    "summary": "string",
    "recipe": [{ "ingredient": "string", "amount": "string", "role": "base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish" }],
    "instructions": "string",
    "glass_type": "coupe | rocks | tiki | collins | null",
    "ingredients": [{ "ingredient": "string", "status": "found | substitute | missing", "location": "string or null", "substitute": "string or null", "substitute_location": "string or null", "flavor_impact": "string or null" }],
    "technique_notes": "string or null",
    "watch_outs": "string or null"
  }
}
"suggestion" must be null (not omitted) if no honest fit exists. watch_outs must be null (not omitted) when there's nothing worth flagging.`,
    }],
  }
  const text = await callClaudeText(body)
  try {
    const parsed = extractJSON(text)
    return parsed?.suggestion || null
  } catch (_) {
    return null
  }
}

async function analyzeExplorationsOriginals(ingredients, template, modifiers, inventoryText, excludeNames = []) {
  const body = {
    model: MODEL,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender building cocktails within a chosen template. Do NOT look up or reference published recipes — these should be your own creative work.

The primary ingredient(s) for this exploration are: ${ingredients.join(', ')}. Use these exact names when referencing them in your response.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}

${buildTemplateContext(template, modifiers)}

${buildTemplateConstraint(template)}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

First check if the featured ingredients fundamentally clash in cocktail contexts. If so, set "incompatible": true and explain briefly in a friendly tone.

Otherwise invent cocktails that showcase the featured ingredients using this priority order, and set each suggestion's "origin" field honestly to reflect which path you actually used — do not default every suggestion to the same value:
1. DEFAULT — origin: "riff": take the template's usual formula above and substitute the featured ingredients (and available bar inventory) into its ratio slots. This is how most real cocktails are made and should be your primary approach for every suggestion.
2. LAST RESORT — origin: "original": only when no reasonable substitution into the template's formula exists, invent a drink that still honors the template's mechanic (stirred/shaken/built/etc.) and general spirit-forward-vs-lengthened character. Do not reach for this by default — it should be rare, and you must set origin: "original" honestly rather than mislabeling an actual substitution as a riff.
For either path, suggest infusions, custom syrups, acid adjustments, fat washing, clarifications, or carbonation where genuinely appropriate, and check every non-garnish, non-pantry-staple ingredient against the bar inventory above (note the generic type and aliases listed alongside each bottle — a bottle's generic type or an alias matching an ingredient the recipe calls for means the user owns it).
${excludeNames.length > 0 ? `\nALREADY SURFACED — the user has already seen these suggestions across earlier batches, each shown with its full ingredient list so you can recognize the underlying swap even under a new name — do not return the same swap again under a different invented name:\n${excludeNames.join('\n')}\nJudge distinctness (see below) against this full list, not just against what you're about to return.\n` : ''}
CRITICAL: Every cocktail MUST feature ALL of the featured ingredients (${ingredients.join(', ')}). Do not omit any featured ingredient from any suggestion.

${SEED_INGREDIENT_EXEMPT}

${OWNERSHIP_STATUS_RULES}

${CAN_MAKE_NOW_RULE}

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin, difficulty, difficulty_note, can_make_now, summary, recipe (array of {ingredient, amount, role}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. The summary field should include a short characterization of the drink's flavor profile (e.g. "Bright and citrus-forward with a bitter backbone"), since there is no separate flavor-preference input from the user anymore. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

Every entry in each suggestion's "recipe" array must include a "role" field from this fixed enum, describing its functional role in the build: ${RECIPE_ROLES.join(' | ')}. "citrus" means citrus juice used as a structural component — a citrus peel or twist used only as garnish is role "garnish", not "citrus". Every ingredient in the recipe gets exactly one role.

${RIFF_DISCIPLINE_BATCH}

${WATCH_OUTS_INSTRUCTION}

Separately from how many you return, report whether more genuinely distinct riffs or originals remain: set "more_ideas_exist" to true only if you are aware of additional swaps or inventions that would pass the riff-discipline bar above beyond what you returned here. Set it false once you've shown everything worth showing — at some point it is the bartender's call: the job is to surface the swaps worth knowing about and then stop, not to enumerate the space and leave the user to filter it. An honest "that's what's here" is a better answer than a longer list of progressively weaker variations. This field must be present on every response.

Return ONLY valid JSON with no markdown fences:
{
  "incompatible": false,
  "incompatibility_reason": null,
  "more_ideas_exist": false,
  "flavor_profile_note": "1-2 sentences on why these ingredients work together",
  "pairs_well_with": "2-3 strongest flavor affinities only — one short sentence, not an exhaustive list",
  "cross_template_suggestion": null,
  "suggestions": [
    {
      "recipe_name": "string",
      "origin": "riff | original",
      "difficulty": "easy | medium | hard",
      "difficulty_note": "One sentence explaining difficulty",
      "can_make_now": true,
      "summary": "1-2 sentence description including a flavor characterization",
      "recipe": [{ "ingredient": "string", "amount": "string", "role": "base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish" }],
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
      "technique_notes": "string or null",
      "watch_outs": "string or null"
    }
  ]
}
cross_template_suggestion is always null from this call — leave it exactly as shown. watch_outs must be null (not omitted) when there's nothing worth flagging. more_ideas_exist must be present (not omitted) on every response.`,
    }],
  }
  const firstText = await callClaudeText(body)
  let data
  try {
    data = extractJSON(firstText)
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
    data = extractJSON(retryText)
  }

  // Change 4/5: code-side structural validation against the chosen template's signature.
  // Every suggestion here is tier-2/3 (riff/original) — tier-1 published recipes never
  // pass through this function. On failure, regenerate that one suggestion once with the
  // specific violation named; if it fails again, drop it. Partial results are expected
  // and fine — never let validation empty a result set that had valid members.
  if (data?.suggestions?.length > 0) {
    const validated = []
    for (const s of data.suggestions) {
      const check = validateSuggestionStructure(s, template)
      if (check.valid) { validated.push(s); continue }
      console.warn('[template validation] failed, regenerating once:', { template, recipe_name: s.recipe_name, violations: check.violations, ingredients })
      const regenerated = await regenerateOriginalSuggestion(ingredients, template, modifiers, inventoryText, s, check.violations)
      if (!regenerated) {
        console.warn('[template validation] regeneration declined, dropping suggestion:', { template, ingredients })
        continue
      }
      const recheck = validateSuggestionStructure(regenerated, template)
      if (recheck.valid) {
        validated.push(regenerated)
      } else {
        console.warn('[template validation] regeneration still invalid, dropping suggestion:', { template, recipe_name: regenerated.recipe_name, violations: recheck.violations, ingredients })
      }
    }
    data.suggestions = validated
  }

  // Both riff and original map to the same legacy origin_flag value — that field
  // only ever distinguished "from the web-search call" vs "from this call," and
  // this call's suggestions were always origin_flag: "original" regardless of
  // which internal tier the model used. Preserved exactly for Favorites/On Deck.
  if (data?.suggestions) data.suggestions = data.suggestions.map(s => ({ ...s, origin_flag: 'original' }))
  // Same normalization rationale as more_published_exist: never trust the literal value,
  // coerce to strict boolean so a malformed/omitted field can't leave a CTA stuck visible.
  if (data) data.more_ideas_exist = data.more_ideas_exist === true
  return data
}

async function refineExplorations(ingredients, template, modifiers, inventoryText, previousNames, feedbackText) {
  const body = {
    model: MODEL,
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender helping someone explore cocktail possibilities.

Today's date is ${TODAY}.

FEATURED INGREDIENTS: ${ingredients.join(' and ')}

${buildTemplateContext(template, modifiers)}

BAR INVENTORY:
${inventoryText}

SHELF LIFE GUIDANCE: Vermouth — 1 month unrefrigerated / 3 months refrigerated. Simple syrup — 2–4 weeks room temp. Amaro — 6–12 months. Commercial liqueurs — 6+ months.

Previous suggestions shown to the user: ${previousNames.join(', ')}

The user provided feedback on the previous suggestions: "${feedbackText}". Based on this feedback, return a revised set of suggestions. If the feedback asks for 'more' or 'additional' results, include new suggestions not previously shown. If the feedback asks for something 'different' or describes a change to a specific recipe, revise accordingly. Return the same JSON structure as before, including updated flavor_profile_note and pairs_well_with if relevant.

Return no more than 4 suggestions total.

${SEED_INGREDIENT_EXEMPT}

${OWNERSHIP_STATUS_RULES}

${CAN_MAKE_NOW_RULE}

Each suggestion MUST include ALL of these fields with non-empty values: recipe_name, origin_flag, difficulty, difficulty_note, can_make_now, summary, recipe (array of {ingredient, amount}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes. The summary field should include a short characterization of the drink's flavor profile. Do not omit or leave any of these fields empty or null except where the schema explicitly allows null (location, substitute, substitute_location, flavor_impact, technique_notes, glass_type).

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
      "summary": "1-2 sentence description including a flavor characterization",
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

async function resolveTemplate(ingredients, affinityData) {
  const affinityContext = ingredients.map(ing => {
    const row = (affinityData || {})[ing.trim().toLowerCase()]
    if (!row) return `${ing}: no affinity data available`
    return `${ing}: ${row.flavor_affinities} Spirit affinities: ${row.spirit_tags?.join(', ')}. Flavor affinities: ${row.flavor_tags?.join(', ')}.`
  }).join('\n\n')

  const templateList = TEMPLATES.map(t => `${t.id} (${t.name} — ${t.formula})`).join('\n')

  const prompt = `You are an expert craft bartender picking the best-fitting cocktail template for a seed ingredient, with no other input from the user.

SEED INGREDIENT(S): ${ingredients.join(', ')}

KNOWN AFFINITY DATA:
${affinityContext}

AVAILABLE TEMPLATES:
${templateList}

Pick exactly one template id that best fits these ingredients. Return ONLY valid JSON, no other text: { "template": "one of the ids listed above" }`

  try {
    const parsed = await callClaude({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    })
    if (parsed?.template && TEMPLATE_MAP[parsed.template]) return parsed.template
  } catch (_) { /* fall through to default */ }
  return 'sour'
}

// Session 6: the contextual affinity layer — how these ingredients behave in
// THIS chosen template with THESE modifiers. Generated fresh every call,
// never persisted or cached: ingredient_affinities already covers the
// stable, template-independent character (the base layer); this covers the
// part that genuinely changes per exploration, so caching it would just go
// stale the moment this prompt changes. Ownership is deliberately absent
// from this prompt — resolved client-side from inventory_tags and applied
// as presentation only, never as a filter on what gets generated here.
async function analyzeContextualAffinities(ingredients, template, modifiers, baseAffinityData) {
  const t = TEMPLATE_MAP[template]
  const sig = TEMPLATE_SIGNATURES[template]
  const baseContext = ingredients.map(ing => {
    const row = (baseAffinityData || {})[ing.trim().toLowerCase()]
    if (!row) return `${ing}: no general affinity data available.`
    return `${ing}: ${row.flavor_affinities}`
  }).join('\n')

  const forbiddenNote = sig?.forbiddenRoles?.length > 0
    ? `This template forbids the following roles — never suggest a spirit or flavor category whose role would be one of these: ${sig.forbiddenRoles.join(', ')}.`
    : ''
  const modifierNote = (modifiers.lowABV || modifiers.na)
    ? `A LOW ABV or NON-ALCOHOLIC modifier is active above. This is not optional flavor and it is not satisfied by prose alone: it must show up in spirit_categories for EVERY ingredient listed, with no exceptions. Concretely — do not list full-proof spirits (whiskey/bourbon/rye, dark rum, gin, tequila, etc.) as a spirit_category for any ingredient, even one that classically pairs with it. Replace each such instinct with its fortified-wine, aperitivo, NA-spirit, or session-strength counterpart instead (e.g. where you would reach for bourbon, suggest a sherry, madeira, or amaro; where you would reach for gin, suggest a fino sherry or blanc vermouth).`
    : ''

  const prompt = `You are an expert craft bartender. The user has already chosen a specific template for this exploration and wants to know how each ingredient behaves specifically in THIS context — not a generic flavor profile.

INGREDIENTS: ${ingredients.join(' and ')}

GENERAL CHARACTER (already known, for reference — do not just repeat this back):
${baseContext}

${buildTemplateContext(template, modifiers)}

For EACH ingredient listed above, in the SAME ORDER, provide:
- contextual_prose: 1-2 sentences on how this specific ingredient behaves in a ${t.name} — not a generic flavor profile, a template-specific one. If a modifier above (LOW ABV, NON-ALCOHOLIC, or FROZEN) is active, factor it into the direction too. Example of the right altitude: for Jägermeister in a Flip, how its herbal bitterness plays against egg and sugar in a dry-shaken build — not just "herbal, bittersweet, baking spice."
- spirit_categories: 2-5 generic spirit/liqueur/fortified-wine CATEGORIES (never brand names) that would genuinely work in this exact template — e.g. "gin", "blanc vermouth", "dry curaçao". Each needs a "role" from this fixed enum: ${RECIPE_ROLES.join(' | ')}.
- flavor_categories: 2-6 generic flavor/ingredient CATEGORIES (never brand names) that suit this template — e.g. "ginger", "stone fruit", "orgeat". Each needs a "role" from the same fixed enum.

${forbiddenNote}
${modifierNote}

Return ONLY valid JSON, no markdown fences:
{
  "ingredients": [
    { "contextual_prose": "string", "spirit_categories": [{ "category": "string", "role": "base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish" }], "flavor_categories": [{ "category": "string", "role": "base | citrus | sweetener | modifier | bitters | lengthener | egg | dairy | garnish" }] }
  ]
}
"ingredients" must have exactly ${ingredients.length} entries, in the same order as listed above.`

  return await callClaude({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  })
}

async function tweakSingleSuggestion(suggestion, feedbackText, inventoryText, tastingContext) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an expert craft bartender. The user wants this specific cocktail suggestion adjusted.

Current suggestion:
${JSON.stringify(stripInternalFields(suggestion), null, 2)}

The user's feedback: "${feedbackText}"${tastingContext ? `\n\n${tastingContext}` : ''}

BAR INVENTORY:
${inventoryText}

${OWNERSHIP_STATUS_RULES}

Return a revised version of just this one suggestion in the same JSON structure as a single suggestion object, re-checking every ingredient in the "ingredients" array (location, substitute, substitute_location, flavor_impact) against the bar inventory above per the ownership rule — do not leave stale or guessed status values from the original. Set can_make_now: true when every ingredient is "found" or "substitute", false only when at least one is "missing". Also include a "tweak_label" field: a short 3-6 word label summarizing what changed (e.g. "Sparkling rosé swap, soda removed"). Return ONLY valid JSON with no markdown fences — a single object, not an array.`,
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

async function converseTweakStep({ suggestion, affinityContext, tweakHistory, messages, isFinal, inventoryText, tastingContext }) {
  const recipeSummary = [
    `Recipe: ${suggestion.recipe_name}`,
    suggestion.recipe?.length > 0 ? `Ingredients: ${suggestion.recipe.map(r => `${r.amount} ${r.ingredient}`).join(', ')}` : null,
    suggestion.instructions ? `Method: ${suggestion.instructions}` : null,
    suggestion.summary ? `Summary: ${suggestion.summary}` : null,
  ].filter(Boolean).join('\n')

  const system = `You are an expert craft bartender diagnosing a cocktail. Terse, direct, expert — no affirmations, no filler, no hedging. Max 2 sentences per response unless writing a final synthesis.

Maintain your diagnostic position across exchanges. If you identify a problem in exchange 1, don't abandon it just because the user asks something new in exchange 2 — connect their question back to your diagnosis or explain why it's a separate issue. Only change your position if the user gives a compelling reason, not just because they asked something different. If the user's second question is unrelated to what you flagged, say so briefly and address both. Never agree with a suggestion just because it was asked — evaluate it on its merits and push back plainly if it won't work.

${recipeSummary}${tastingContext ? `\n\n${tastingContext}` : ''}${tweakHistory.length > 0 ? `\n\nPrior tweaks on this recipe's lineage:\n${tweakHistory.map(p => `- "${p}"`).join('\n')}` : ''}${affinityContext ? `\n\nAffinity reference:\n${affinityContext}` : ''}`

  if (isFinal) {
    const finalMessages = [
      ...messages,
      {
        role: 'user',
        content: `Synthesize this into a concrete tweak. Write one sentence starting with "Based on what you're describing, here's what I'd try: " Then write "---JSON---" on a new line followed by the complete revised recipe as valid JSON — same structure as the original with all fields: recipe_name, origin_flag, difficulty, difficulty_note, can_make_now, summary, recipe (array of {ingredient, amount}), instructions, glass_type, ingredients (array of {ingredient, status, location, substitute, substitute_location, flavor_impact}), technique_notes, tweak_label (a short 3-6 word label summarizing what changed, e.g. "Sparkling rosé swap, soda removed"). Re-check every ingredient's status/location/substitute against this bar inventory instead of leaving stale values from the original:\n\n${inventoryText}\n\n${OWNERSHIP_STATUS_RULES}\n\nSet can_make_now: true when every ingredient is "found" or "substitute", false only when at least one is "missing".`,
      },
    ]
    const body = { model: MODEL, max_tokens: 1500, system, messages: finalMessages }
    const text = await callClaudeText(body)
    const sepIdx = text.indexOf('---JSON---')
    const synthesisText = (sepIdx >= 0 ? text.slice(0, sepIdx) : text).trim()
    const jsonPart = sepIdx >= 0 ? text.slice(sepIdx + 10).trim() : ''
    let revised = null
    if (jsonPart) { try { revised = extractJSON(jsonPart) } catch (_) {} }
    if (!revised) {
      const retryText = await callClaudeText({
        model: MODEL, max_tokens: 1500, system,
        messages: [...finalMessages, { role: 'assistant', content: text }, { role: 'user', content: 'Return ONLY the revised recipe as valid JSON, no other text.' }],
      })
      try { revised = extractJSON(retryText) } catch (_) {}
    }
    return { synthesisText, revised }
  } else {
    const text = await callClaudeText({ model: MODEL, max_tokens: 300, system, messages })
    return { text }
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

function IngredientDrawer({
  item, flavorProfile, loading, onClose, inventory,
  showFlavorProfile = true,
  tags, distinctGenericTypes, onSetGenericType, onRetag, retagging,
}) {
  const invMatch = inventory?.find(inv =>
    inv.spirit.toLowerCase() === item.ingredient.toLowerCase() ||
    item.ingredient.toLowerCase().includes(inv.spirit.toLowerCase()) ||
    inv.spirit.toLowerCase().includes(item.ingredient.toLowerCase())
  )
  const tag = tags && invMatch ? tags[invMatch.spirit.trim().toLowerCase()] : null

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
        {showFlavorProfile && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Flavor Profile</div>
            {loading
              ? <div style={{ color: C.textMuted, fontSize: 14 }}>Loading…</div>
              : <p style={{ fontSize: 14, color: C.text, lineHeight: 1.65, margin: 0 }}>{flavorProfile || '—'}</p>
            }
          </div>
        )}

        {/* Generic type (Session 4 semantic tagging) */}
        {invMatch && onSetGenericType && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint }}>Generic Type</div>
              {onRetag && (
                <button onClick={() => onRetag(invMatch)} disabled={retagging} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: retagging ? C.textFaint : C.textMuted, fontSize: 11, padding: '3px 8px', cursor: retagging ? 'default' : 'pointer' }}>
                  {retagging ? 'Retagging…' : '↻ Retag'}
                </button>
              )}
            </div>
            <select
              value={tag?.generic_type || ''}
              onChange={e => e.target.value && onSetGenericType(invMatch.spirit, e.target.value)}
              style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, padding: '8px 10px', fontSize: 14 }}
            >
              <option value="" disabled>{tag ? tag.generic_type : '— untagged —'}</option>
              {distinctGenericTypes?.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {tag?.aliases?.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {tag.aliases.map(a => (
                  <span key={a} style={{ fontSize: 11, color: C.textFaint, background: C.border, borderRadius: 4, padding: '2px 6px' }}>{a}</span>
                ))}
              </div>
            )}
          </div>
        )}

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

// Session 6: what tapping an owned category chip on the affinities screen
// reveals. Same bottom-sheet affordance as IngredientDrawer/InventoryScreen
// (Session 4) rather than a new pattern, but shaped around a category with
// potentially several matching bottles instead of one matched item.
function CategoryBottlesDrawer({ category, bottles, onAddGeneric, onAddBottle, onClose }) {
  // Owned bottles and the generic "(unspecified)" option are peers, not a
  // primary action and a fallback — both add to the exploration, so both
  // get the same row treatment. Owned bottles list first; the generic
  // option is always last, whether or not anything is owned.
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 99, transition: 'opacity 0.25s' }} />
      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 700, background: '#1c1c1c', borderTop: `1px solid ${C.border}`, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '20px 20px 36px', zIndex: 100, maxHeight: '72vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>{category}</div>
          <button onClick={onClose} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, fontSize: 20, lineHeight: 1, padding: '2px 9px', cursor: 'pointer', flexShrink: 0 }}>×</button>
        </div>
        {bottles.length > 0 && (
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 10 }}>You own</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bottles.map(b => (
            <div key={b.spirit} onClick={() => onAddBottle(b.spirit)} style={rowStyle}>
              <span style={{ fontSize: 14, color: C.text }}>{b.spirit}</span>
              {b.location && <span style={{ fontSize: 12, color: C.textMuted }}>📍 {b.location}</span>}
            </div>
          ))}
          <div onClick={onAddGeneric} style={rowStyle}>
            <span style={{ fontSize: 14, color: C.text }}>{category} (unspecified)</span>
          </div>
        </div>
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
  const isMissing = item.status === 'missing'
  const dotColor = item.status === 'found' ? C.green : item.status === 'substitute' ? C.amber : C.missing

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span style={{ display: 'inline-block', width: isMissing ? 10 : 9, height: isMissing ? 10 : 9, borderRadius: '50%', background: dotColor, boxShadow: isMissing ? `0 0 0 3px ${C.missing}33` : 'none', flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
            <span onClick={() => onOpenDrawer(item)} style={{ fontWeight: 600, fontSize: 15, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{item.ingredient}</span>
            {isMissing && <Chip color={C.missing}>missing</Chip>}
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

const ORIGIN_BADGE_LABELS = {
  published: '📖 From a recipe',
  riff: '🔁 Riff',
  original: '✨ Original',
}

function OriginBadge({ origin, originFlag }) {
  // Resolution order: real self-reported `origin` (3-way) first; then the legacy
  // `origin_flag` (2-way, from suggestions generated before this field existed,
  // or from Refine/Tweak which still only emit origin_flag) mapped losslessly
  // where possible (from_recipe → published) and conservatively where not
  // (anything else → original, since we can't recover whether an old
  // "original"-flagged item was secretly a riff); no signal at all → no badge,
  // matching prior behavior for Favorites/On Deck items with nothing set.
  const resolved = origin || (originFlag ? (originFlag === 'from_recipe' ? 'published' : 'original') : null)
  if (!resolved) return null
  return (
    <span style={{ fontSize: 11, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 7px', color: C.textMuted }}>
      {ORIGIN_BADGE_LABELS[resolved] || ORIGIN_BADGE_LABELS.original}
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

// TODO: unify with shared RecipeCard once the Analyze/Name/Menu flow is in scope (Session 1.5)
function Results({ result, adjustmentNote, shoppingList, onAddToList, favorites, onToggleFavorite, toMake, onToggleToMake, onFeedback, feedbackLoading, inventory, feedbackError }) {
  const [tab, setTab] = useState('ingredients')
  const [feedbackText, setFeedbackText] = useState('')
  const adjustmentNoteRef = useRef(null)
  const [drawerItem, setDrawerItem] = useState(null)
  const [flavorCache, setFlavorCache] = useState({})
  const [drawerLoading, setDrawerLoading] = useState(false)

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

  const handleFeedbackSubmit = async () => {
    if (!feedbackText.trim()) return
    const ok = await onFeedback(feedbackText.trim())
    if (ok) setFeedbackText('')
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          onClick={() => onToggleToMake(result)}
          style={{ background: 'none', border: `1px solid ${isToMake ? C.blue : C.border}`, borderRadius: 20, color: isToMake ? C.blue : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s' }}
        >
          {isToMake ? '🍹 Saved to On Deck' : '🍹 On Deck'}
        </button>
        <button
          onClick={() => onToggleFavorite(result)}
          style={{ background: 'none', border: `1px solid ${isFav ? C.gold : C.border}`, borderRadius: 20, color: isFav ? C.gold : C.textMuted, fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s' }}
        >
          {isFav ? '♥ Saved' : '♡ Save to Favorites'}
        </button>
      </div>

      {result.summary && (
        <p style={{ color: C.textMuted, fontSize: 15, marginBottom: result._trainingDataFallback ? 10 : 24, lineHeight: 1.65, maxWidth: 600 }}>
          {result.summary}
        </p>
      )}
      {result._trainingDataFallback && (
        <p style={{ fontSize: 12, color: C.textFaint, marginBottom: 20 }}>Recipe sourced from training data — web search unavailable.</p>
      )}

      {/* Adjustment note */}
      {adjustmentNote && (
        <div ref={adjustmentNoteRef} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: C.gold + '18', border: `1px solid ${C.gold}44`, borderRadius: 10, padding: '12px 16px', marginBottom: 20 }}>
          <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>✓</span>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.gold }}>Adjusted </span>
            <span style={{ fontSize: 14, color: C.text }}>{adjustmentNote}</span>
          </div>
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
            {feedbackLoading ? 'Revising…' : 'Something Off? Adjust'}
          </button>
        </div>
        {feedbackError && <div style={{ fontSize: 13, color: C.red, marginTop: 8 }}>{feedbackError}</div>}
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

function InventoryScreen({
  inventory, inStockCount, oosCount,
  inventoryTags, inventoryTagsError, untaggedBottles, distinctGenericTypes,
  tagSweepInProgress, tagSweepProgress, tagSweepError,
  onTagSweep, onSetGenericType,
}) {
  const [selectedCats, setSelectedCats] = useState(new Set())
  const [drawerItem, setDrawerItem] = useState(null)

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
  const untaggedCount = untaggedBottles?.length || 0

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{inStockCount} in stock</span>
        {oosCount > 0 && <span style={{ fontSize: 13, background: C.amber + '22', color: C.amber, border: `1px solid ${C.amber}44`, borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>{oosCount} OOS</span>}
      </div>

      {/* Untagged banner — self-clearing at zero, so no stale control lingers */}
      {inventoryTagsError && (
        <div style={{ fontSize: 13, color: C.red, background: C.red + '12', border: `1px solid ${C.red}33`, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          Tag storage unavailable: {inventoryTagsError} — has the inventory_tags migration been run?
        </div>
      )}
      {untaggedCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', background: C.gold + '12', border: `1px solid ${C.gold}33`, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: C.text }}>
            {untaggedCount} bottle{untaggedCount === 1 ? '' : 's'} not yet tagged
            {tagSweepInProgress && tagSweepProgress && ` — tagging ${tagSweepProgress.done}/${tagSweepProgress.total}…`}
          </span>
          <button
            onClick={() => onTagSweep(untaggedBottles)}
            disabled={tagSweepInProgress}
            style={{ background: 'none', border: `1px solid ${C.gold}55`, borderRadius: 6, color: C.gold, fontSize: 12, fontWeight: 600, padding: '4px 10px', cursor: tagSweepInProgress ? 'default' : 'pointer', opacity: tagSweepInProgress ? 0.6 : 1 }}
          >
            {tagSweepInProgress ? 'Tagging…' : 'Tag now'}
          </button>
        </div>
      )}
      {tagSweepError && (
        <div style={{ fontSize: 13, color: C.red, background: C.red + '12', border: `1px solid ${C.red}33`, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          Tagging failed: {tagSweepError}
        </div>
      )}

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
              const genericType = inventoryTags?.[item.spirit.trim().toLowerCase()]?.generic_type
              return (
                <div key={i} onClick={() => setDrawerItem({ ingredient: item.spirit, location: item.location })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.surface, borderRadius: 8, flexWrap: 'wrap', cursor: 'pointer' }}>
                  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: item.oos ? C.amber : C.green, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, flex: 1, minWidth: 120 }}>{item.spirit}</span>
                  {item.subLocation && <span style={{ fontSize: 12, color: C.textMuted }}>{item.subLocation}</span>}
                  {item.category && <span style={{ fontSize: 11, color: C.textMuted, background: C.border, borderRadius: 4, padding: '2px 6px' }}>{item.category}</span>}
                  {genericType && <span style={{ fontSize: 11, fontWeight: 600, color: C.gold, background: C.gold + '15', border: `1px solid ${C.gold}33`, borderRadius: 4, padding: '2px 6px' }}>{genericType}</span>}
                  {item.oos && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>OOS</span>}
                  {isExpired && <span style={{ fontSize: 11, fontWeight: 700, color: C.red, background: C.red + '18', border: `1px solid ${C.red}44`, borderRadius: 4, padding: '2px 6px' }}>Exp {expiry.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>}
                  {expiringSoon && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber, background: C.amber + '18', border: `1px solid ${C.amber}44`, borderRadius: 4, padding: '2px 6px' }}>Exp {expiry.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {drawerItem && (
        <IngredientDrawer
          item={drawerItem}
          onClose={() => setDrawerItem(null)}
          inventory={inventory}
          showFlavorProfile={false}
          tags={inventoryTags}
          distinctGenericTypes={distinctGenericTypes}
          onSetGenericType={onSetGenericType}
          onRetag={(invItem) => onTagSweep([invItem])}
          retagging={tagSweepInProgress}
        />
      )}
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
              <OriginBadge origin={fav.origin} originFlag={fav.originFlag} />
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
              <OriginBadge origin={item.origin} originFlag={item.originFlag} />
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

// ─── Saved Screen ─────────────────────────────────────────────────────────────

const SOURCE_OPTIONS = ['All', 'Recipe Screenshot', 'Bar Menu', 'Cocktail Name', 'Exploration']

function SavedScreen({ savedSubTab, setSavedSubTab, toMake, favorites, onRemoveToMake, onRemoveFavorite, onViewToMake, onViewFavorite, onUpdateNote }) {
  const [sourceFilter, setSourceFilter] = useState('All')
  const [ingredientFilter, setIngredientFilter] = useState(null)

  const SUB_TABS = [
    { id: 'ondeck',   label: 'On Deck',   count: toMake.length,    color: C.blue },
    { id: 'favorites',label: 'Favorites', count: favorites.length, color: C.gold },
  ]

  const currentList = savedSubTab === 'ondeck' ? toMake : favorites

  let filteredList = sourceFilter === 'All' ? currentList : currentList.filter(i => (i.source || 'manual') === sourceFilter)
  if (sourceFilter === 'Exploration' && ingredientFilter) {
    filteredList = filteredList.filter(i => (i.primaryIngredients || []).includes(ingredientFilter))
  }

  const uniqueIngredients = [...new Set(
    currentList.filter(i => i.source === 'Exploration').flatMap(i => i.primaryIngredients || [])
  )]

  const emptyMsg = currentList.length === 0
    ? savedSubTab === 'ondeck' ? 'No recipes on deck yet. Analyze a recipe and tap 🍹 On Deck.'
      : 'No saved favorites yet. Analyze a recipe and tap ♡ Save to Favorites.'
    : 'No items match the current filter.'

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {SUB_TABS.map(({ id, label, count, color }) => {
          const active = savedSubTab === id
          return (
            <button key={id} onClick={() => { setSavedSubTab(id); setSourceFilter('All'); setIngredientFilter(null) }}
              style={{ flex: 1, background: 'none', border: 'none', borderBottom: active ? `2px solid ${color}` : '2px solid transparent', color: active ? color : C.textMuted, fontSize: 13, fontWeight: active ? 600 : 400, padding: '10px 4px', cursor: 'pointer', marginBottom: -1, transition: 'color 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              {label}
              <span style={{ fontSize: 10, fontWeight: 700, background: color + '33', color, borderRadius: 10, padding: '1px 5px' }}>
                {count}
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
  const [showSecondInput, setShowSecondInput] = useState(false)

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
      {selected.length === 1 && !showSecondInput && (
        <button onClick={() => setShowSecondInput(true)}
          style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 13, cursor: 'pointer', padding: '4px 0', display: 'block' }}>
          + add a second ingredient
        </button>
      )}
      {(selected.length === 0 || (selected.length === 1 && showSecondInput)) && (
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

function makeExplorationKey(ingredients, template, frozen, lowABV, na) {
  return [[...ingredients].sort().join(','), template, String(frozen), String(lowABV), String(na)].join('|')
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

function TweakModal({ suggestion, user, whiteboardId, recipeNodeId, inventoryText, tried, notes, onClose, onApply }) {
  const [mode, setMode] = useState('choose')
  const [directText, setDirectText] = useState('')
  const [directLoading, setDirectLoading] = useState(false)
  const [directError, setDirectError] = useState(null)
  const [convMessages, setConvMessages] = useState([])
  const [convInput, setConvInput] = useState('')
  const [exchangeCount, setExchangeCount] = useState(0)
  const [isConvLoading, setIsConvLoading] = useState(false)
  const [convError, setConvError] = useState(null)
  const [synthesisText, setSynthesisText] = useState('')
  const [proposedRevision, setProposedRevision] = useState(null)
  const [affinities, setAffinities] = useState([])
  const [affinitiesOpen, setAffinitiesOpen] = useState(false)
  const [tweakHistory, setTweakHistory] = useState([])

  useEffect(() => {
    const fetchContext = async () => {
      const ingredientNames = (suggestion.recipe || []).map(r => r.ingredient.trim().toLowerCase())
      if (ingredientNames.length > 0) {
        try {
          const { data } = await supabase.from('ingredient_affinities').select('ingredient_name, flavor_affinities, spirit_tags, flavor_tags').in('ingredient_name', ingredientNames)
          if (data?.length > 0) setAffinities(data)
        } catch (_) {}
      }
      if (user && whiteboardId && recipeNodeId) {
        try {
          // Walk the full parent chain (not just direct children) so prior tweaks
          // anywhere in this recipe's lineage surface here, not only ones parented
          // directly to the current node.
          const { data: allNodes } = await supabase.from('exploration_nodes').select('id, parent_node_id, node_type, payload').eq('whiteboard_id', whiteboardId)
          if (allNodes?.length > 0) {
            const byId = {}
            allNodes.forEach(n => { byId[n.id] = n })
            const chain = []
            let cur = byId[recipeNodeId]
            while (cur) { chain.unshift(cur); cur = cur.parent_node_id ? byId[cur.parent_node_id] : null }
            const priorTweaks = chain.filter(n => n.node_type === 'tweak').map(n => n.payload?.tweak_label || n.payload?.prompt).filter(Boolean)
            if (priorTweaks.length > 0) setTweakHistory(priorTweaks)
          }
        } catch (_) {}
      }
    }
    fetchContext()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const affinityContext = affinities.map(a => `${a.ingredient_name}: ${[...(a.spirit_tags || []), ...(a.flavor_tags || [])].slice(0, 6).join(', ')}`).join('\n')
  const tastingContext = (tried || notes)
    ? [tried ? 'The user has tried this recipe.' : null, notes ? `Their tasting note: "${notes}"` : null].filter(Boolean).join(' ')
    : null

  const handleDirectSubmit = async () => {
    if (!directText.trim() || directLoading) return
    setDirectLoading(true)
    setDirectError(null)
    const promptText = directText.trim()
    try {
      const revised = await tweakSingleSuggestion(suggestion, promptText, inventoryText, tastingContext)
      onApply({ prompt: promptText, result: revised, conversation: null, tweakLabel: revised?.tweak_label })
      onClose()
    } catch (err) {
      setDirectError(err.message || 'Could not apply tweak. Please try again.')
      setDirectLoading(false)
    }
  }

  const handleConvSend = async () => {
    if (!convInput.trim() || isConvLoading) return
    setIsConvLoading(true)
    setConvError(null)
    const userMsg = { role: 'user', content: convInput.trim() }
    const newMessages = [...convMessages, userMsg]
    setConvMessages(newMessages)
    setConvInput('')
    const newCount = exchangeCount + 1
    setExchangeCount(newCount)
    try {
      const isFinal = newCount >= 2
      const res = await converseTweakStep({ suggestion, affinityContext, tweakHistory, messages: newMessages, isFinal, inventoryText, tastingContext })
      if (isFinal) {
        setConvMessages(prev => [...prev, { role: 'assistant', content: res.synthesisText }])
        setSynthesisText(res.synthesisText)
        setProposedRevision(res.revised)
        setMode('synthesis')
      } else {
        setConvMessages(prev => [...prev, { role: 'assistant', content: res.text }])
      }
    } catch (err) {
      setConvMessages(prev => prev.slice(0, -1))
      setConvInput(userMsg.content)
      setExchangeCount(newCount - 1)
      setConvError(err.message || 'Something went wrong. Try again.')
    } finally {
      setIsConvLoading(false)
    }
  }

  const handleRevise = () => {
    setMode('chat')
    setConvMessages([])
    setConvInput('')
    setExchangeCount(0)
    setSynthesisText('')
    setProposedRevision(null)
  }

  const affinitiesPanel = (
    <div style={{ marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
      <button onClick={() => setAffinitiesOpen(o => !o)}
        style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
        What works with these ingredients {affinitiesOpen ? '▲' : '▼'}
      </button>
      {affinitiesOpen && (
        <div style={{ marginTop: 10 }}>
          {affinities.length === 0
            ? <div style={{ fontSize: 12, color: C.textFaint }}>No affinity data available.</div>
            : affinities.map(a => (
              <div key={a.ingredient_name} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.gold, marginBottom: 5, textTransform: 'capitalize' }}>{a.ingredient_name}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {[...(a.spirit_tags || []), ...(a.flavor_tags || [])].slice(0, 8).map(tag => (
                    <span key={tag} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontSize: 11, padding: '2px 8px' }}>{tag}</span>
                  ))}
                </div>
              </div>
            ))
          }
        </div>
      )}
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 900, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: '100%', maxWidth: 600, background: C.bg, borderRadius: '16px 16px 0 0', padding: '20px 20px 36px', maxHeight: '80vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 2 }}>Tweaking</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{suggestion.recipe_name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 20, cursor: 'pointer', padding: 0, marginLeft: 'auto', lineHeight: 1 }}>✕</button>
        </div>

        {mode === 'choose' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={() => setMode('direct')}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 14, fontWeight: 600, padding: '16px', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ marginBottom: 3 }}>I know what I want</div>
              <div style={{ fontSize: 12, color: C.textFaint, fontWeight: 400 }}>Type a direct instruction and apply immediately</div>
            </button>
            <button onClick={() => setMode('chat')}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 14, fontWeight: 600, padding: '16px', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ marginBottom: 3 }}>Help me figure it out</div>
              <div style={{ fontSize: 12, color: C.textFaint, fontWeight: 400 }}>Talk through the idea first, then apply</div>
            </button>
            {affinitiesPanel}
          </div>
        )}

        {mode === 'direct' && (
          <div>
            <button onClick={() => setMode('choose')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 13, cursor: 'pointer', padding: '0 0 16px', display: 'block' }}>← Back</button>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={directText} onChange={e => setDirectText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleDirectSubmit()}
                placeholder="e.g. make it less sweet, use bourbon instead" disabled={directLoading} autoFocus
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, padding: '10px 12px', outline: 'none', opacity: directLoading ? 0.5 : 1 }} />
              <button onClick={handleDirectSubmit} disabled={!directText.trim() || directLoading}
                style={{ background: directText.trim() && !directLoading ? C.gold : C.surface, border: `1px solid ${directText.trim() && !directLoading ? C.gold : C.border}`, borderRadius: 8, color: directText.trim() && !directLoading ? '#0f0f0f' : C.textFaint, fontSize: 13, fontWeight: 600, padding: '10px 14px', cursor: directText.trim() && !directLoading ? 'pointer' : 'default', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                {directLoading && <span style={{ display: 'inline-block', width: 11, height: 11, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'bcspini 0.6s linear infinite', flexShrink: 0 }} />}
                {directLoading ? 'Tweaking…' : 'Apply'}
              </button>
            </div>
            {directError && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{directError}</div>}
            {affinitiesPanel}
          </div>
        )}

        {(mode === 'chat' || mode === 'synthesis') && (
          <div>
            <button onClick={() => setMode('choose')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 13, cursor: 'pointer', padding: '0 0 14px', display: 'block' }}>← Back</button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
              {convMessages.map((msg, i) => (
                <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', background: msg.role === 'user' ? C.gold + '22' : C.surface, border: `1px solid ${msg.role === 'user' ? C.gold + '44' : C.border}`, borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px', padding: '8px 12px', fontSize: 14, color: C.text, lineHeight: 1.5, display: 'block' }}>
                  {msg.content}
                </div>
              ))}
              {isConvLoading && (
                <div style={{ alignSelf: 'flex-start', background: C.surface, border: `1px solid ${C.border}`, borderRadius: '10px 10px 10px 2px', padding: '10px 14px' }}>
                  <span style={{ display: 'inline-block', width: 11, height: 11, border: `2px solid ${C.textFaint}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'bcspini 0.6s linear infinite' }} />
                </div>
              )}
            </div>

            {mode === 'chat' && (
              <div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="text" value={convInput} onChange={e => setConvInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleConvSend()}
                    placeholder={convMessages.length === 0 ? "What are you thinking about changing?" : "Reply…"} disabled={isConvLoading} autoFocus
                    style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, padding: '10px 12px', outline: 'none', opacity: isConvLoading ? 0.5 : 1 }} />
                  <button onClick={handleConvSend} disabled={!convInput.trim() || isConvLoading}
                    style={{ background: convInput.trim() && !isConvLoading ? C.gold : C.surface, border: `1px solid ${convInput.trim() && !isConvLoading ? C.gold : C.border}`, borderRadius: 8, color: convInput.trim() && !isConvLoading ? '#0f0f0f' : C.textFaint, fontSize: 16, fontWeight: 700, padding: '10px 16px', cursor: convInput.trim() && !isConvLoading ? 'pointer' : 'default' }}>
                    →
                  </button>
                </div>
                {convError && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{convError}</div>}
              </div>
            )}

            {mode === 'synthesis' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { onApply({ prompt: synthesisText, result: proposedRevision, conversation: convMessages, tweakLabel: proposedRevision?.tweak_label }); onClose() }}
                  disabled={!proposedRevision}
                  style={{ flex: 1, background: proposedRevision ? C.gold : C.surface, border: `1px solid ${proposedRevision ? C.gold : C.border}`, borderRadius: 8, color: proposedRevision ? '#0f0f0f' : C.textFaint, fontSize: 14, fontWeight: 700, padding: '12px', cursor: proposedRevision ? 'pointer' : 'default' }}>
                  Apply Tweak
                </button>
                <button onClick={handleRevise}
                  style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 13, fontWeight: 500, padding: '12px 16px', cursor: 'pointer' }}>
                  Revise
                </button>
              </div>
            )}

            {affinitiesPanel}
          </div>
        )}
      </div>
    </div>
  )
}

function RecipeCard({
  suggestion,
  primaryIngredients = [],
  onSaveOnDeck = null,
  user = null,
  whiteboardId = null,
  recipeListNodeId = null,
  recipeNodeIds = null,
  autoExpand = false,
  restoreRecipeNodeId = null,
  initialTried = false,
  initialNotes = '',
  showSaveButtons = true,
  showRefineCTA = true,
  onTriedToggle = null,
  onNotesSave = null,
  inventoryText = '',
}) {
  const [expanded, setExpanded] = useState(!!autoExpand)
  const [savedTo, setSavedTo] = useState(null)
  const [tweakedSuggestion, setTweakedSuggestion] = useState(null)
  const [tweakDone, setTweakDone] = useState(false)
  const [tweakModalOpen, setTweakModalOpen] = useState(false)
  const [tried, setTried] = useState(initialTried)
  const [notes, setNotes] = useState(initialNotes)
  const [lineage, setLineage] = useState(null) // { parentName } once a tweak has been applied this session
  const [showOriginal, setShowOriginal] = useState(false)
  const recipeNodeIdRef = useRef(restoreRecipeNodeId || recipeNodeIds?.[suggestion.recipe_name] || null)
  const cardRef = useRef(null)
  const pendingTriedRef = useRef(null)
  const pendingNotesRef = useRef(null)
  // Textarea onChange keeps `notes` state current on every keystroke (only the DB write
  // waits for blur) — mirror it into a ref so the unmount-flush effect below always sees
  // the latest typed value, even though its own closure is fixed at mount.
  const notesRef = useRef(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  const savedNotesRef = useRef(initialNotes)
  const handleNotesSaveRef = useRef(null)

  useEffect(() => {
    if (autoExpand && cardRef.current) {
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync ref when eager recipe-node writes complete after cards have already rendered.
  // Flush any tried/notes mutations that arrived before the ID was known.
  useEffect(() => {
    if (!recipeNodeIdRef.current && recipeNodeIds?.[suggestion.recipe_name]) {
      recipeNodeIdRef.current = recipeNodeIds[suggestion.recipe_name]
      if (user) {
        if (pendingTriedRef.current !== null) {
          const p = pendingTriedRef.current
          supabase.from('exploration_nodes').update({ tried: p.tried, tried_at: p.tried_at }).eq('id', recipeNodeIdRef.current).then()
          pendingTriedRef.current = null
        }
        if (pendingNotesRef.current !== null) {
          supabase.from('exploration_nodes').update({ notes: pendingNotesRef.current }).eq('id', recipeNodeIdRef.current).then()
          pendingNotesRef.current = null
        }
      }
    }
  }, [recipeNodeIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const displayed = tweakedSuggestion || suggestion

  const handleOnDeck = () => {
    onSaveOnDeck(displayed, primaryIngredients)
    setSavedTo('ondeck')
  }

  const handleToggleExpand = async () => {
    const next = !expanded
    setExpanded(next)
    if (next && !recipeNodeIdRef.current && user && whiteboardId && recipeListNodeId) {
      try {
        const { data } = await supabase
          .from('exploration_nodes')
          .insert({ whiteboard_id: whiteboardId, parent_node_id: recipeListNodeId, node_type: 'recipe', payload: { recipe: displayed } })
          .select('id').single()
        recipeNodeIdRef.current = data?.id ?? null
        if (data?.id) {
          await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', whiteboardId)
        }
      } catch (err) {
        console.warn('[whiteboard] recipe node write failed:', err.message)
      }
    }
  }

  const handleToggleTried = () => {
    const next = !tried
    const triedAt = next ? new Date().toISOString() : null
    setTried(next)
    if (onTriedToggle) {
      onTriedToggle(next, triedAt)
    } else if (recipeNodeIdRef.current && user) {
      supabase.from('exploration_nodes').update({ tried: next, tried_at: triedAt }).eq('id', recipeNodeIdRef.current).then()
    } else {
      pendingTriedRef.current = { tried: next, tried_at: triedAt }
    }
  }

  const handleNotesSave = (value) => {
    savedNotesRef.current = value
    if (onNotesSave) {
      onNotesSave(value)
    } else if (recipeNodeIdRef.current && user) {
      supabase.from('exploration_nodes').update({ notes: value }).eq('id', recipeNodeIdRef.current).then()
    } else {
      pendingNotesRef.current = value
    }
  }
  useEffect(() => { handleNotesSaveRef.current = handleNotesSave })

  // Notes only save on textarea blur — if the user navigates away (Back, tab switch, etc.)
  // without blurring first, this flushes whatever was last typed so it isn't silently lost.
  useEffect(() => {
    return () => {
      if (notesRef.current !== savedNotesRef.current) handleNotesSaveRef.current(notesRef.current)
    }
  }, [])

  const handleTweakApply = async ({ prompt, result, conversation, tweakLabel }) => {
    const parentNodeId = recipeNodeIdRef.current
    const parentName = displayed.recipe_name || suggestion.recipe_name
    // origin is derived from the parent, never asked of the model: once a drink leaves
    // tier-1 it cannot return, so a published parent's tweak is a riff (a canonical
    // formula with a part swapped is the definition of a riff), while a riff or original
    // parent's tweak stays exactly what it was. `displayed.origin` is the current
    // (possibly already-tweaked) state, so this derivation cascades correctly across
    // repeated tweaks. A legacy parent with no origin leaves the tweak's origin unset,
    // letting the origin_flag fallback in OriginBadge handle it.
    const parentOrigin = displayed.origin
    const stampedResult = parentOrigin
      ? { ...result, origin: parentOrigin === 'published' ? 'riff' : parentOrigin }
      : result
    setTweakedSuggestion(stampedResult)
    setTweakDone(true)
    // The tweak is a new, untasted version of the recipe — its own identity, own
    // node id going forward. Tried/notes must never bleed over from the parent.
    setTried(false)
    setNotes('')
    savedNotesRef.current = ''
    setShowOriginal(false)
    setLineage({ parentName })
    if (user && whiteboardId && parentNodeId) {
      try {
        const payload = conversation?.length > 0
          ? { prompt, result: stampedResult, conversation, tweak_label: tweakLabel || null }
          : { prompt, result: stampedResult, tweak_label: tweakLabel || null }
        const { data } = await supabase.from('exploration_nodes').insert({ whiteboard_id: whiteboardId, parent_node_id: parentNodeId, node_type: 'tweak', payload }).select('id').single()
        if (data?.id) recipeNodeIdRef.current = data.id
        await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', whiteboardId)
      } catch (err) {
        console.warn('[whiteboard] tweak node write failed:', err.message)
      }
    }
  }

  return (
    <div ref={cardRef} style={showSaveButtons ? { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' } : {}}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: showSaveButtons ? 5 : 3 }}>
          <span style={{ fontWeight: 700, fontSize: showSaveButtons ? 16 : 14, color: C.gold }}>{displayed.recipe_name || 'Untitled suggestion'}</span>
          {showSaveButtons && displayed.glass_type && <GlassIcon type={displayed.glass_type} />}
        </div>
        {showSaveButtons && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
            <OriginBadge origin={displayed.origin} originFlag={displayed.origin_flag} />
            <DifficultyBadge difficulty={displayed.difficulty} />
          </div>
        )}
        {showSaveButtons && displayed.difficulty_note && <div style={{ fontSize: 12, color: C.textFaint, marginTop: 2 }}>{displayed.difficulty_note}</div>}
      </div>

      {displayed.summary && <p style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.55, marginBottom: 10 }}>{displayed.summary}</p>}

      {displayed.watch_outs && <p style={{ fontSize: 12, color: C.textFaint, fontStyle: 'italic', lineHeight: 1.5, marginTop: -4, marginBottom: 10 }}>{displayed.watch_outs}</p>}

      {lineage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: C.textFaint, marginBottom: 10 }}>
          <span>↳ tweaked from <span style={{ color: C.textMuted }}>{lineage.parentName}</span></span>
          <button onClick={() => setShowOriginal(o => !o)}
            style={{ background: 'none', border: 'none', color: C.gold, fontSize: 12, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
            {showOriginal ? 'Hide original' : 'View original'}
          </button>
        </div>
      )}
      {lineage && showOriginal && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 6 }}>Original recipe</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.gold, marginBottom: 4 }}>{suggestion.recipe_name}</div>
          {suggestion.summary && <p style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>{suggestion.summary}</p>}
        </div>
      )}

      <button onClick={handleToggleExpand}
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
          {showSaveButtons && displayed.ingredients && displayed.ingredients.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {displayed.ingredients.filter(ing => ing.ingredient).map((ing, i) => {
                const ingMissing = ing.status === 'missing'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
                    <span style={{ display: 'inline-block', width: ingMissing ? 8 : 7, height: ingMissing ? 8 : 7, borderRadius: '50%', background: ing.status === 'found' ? C.green : ing.status === 'substitute' ? C.amber : C.missing, boxShadow: ingMissing ? `0 0 0 3px ${C.missing}33` : 'none', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <span style={{ color: C.text }}>{ing.ingredient}</span>
                      {ing.location && <span style={{ color: C.textMuted }}> · 📍 {ing.location}</span>}
                      {ing.substitute && <div style={{ color: C.textFaint, fontStyle: 'italic', marginTop: 2 }}>Sub: {ing.substitute}{ing.flavor_impact ? ` — ${ing.flavor_impact}` : ''}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 5 }}>Tasting Notes</div>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={e => handleNotesSave(e.target.value)}
          placeholder="Add your tasting notes…"
          rows={2}
          style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 13, padding: '8px 10px', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={handleToggleTried}
          style={{ background: tried ? C.green + '22' : 'none', border: `1px solid ${tried ? C.green : C.border}`, borderRadius: 20, color: tried ? C.green : C.textMuted, fontSize: 12, fontWeight: tried ? 700 : 400, padding: '4px 12px', cursor: 'pointer', transition: 'all 0.15s' }}>
          {tried ? '✓ Tried' : 'Mark Tried'}
        </button>
        {showSaveButtons && (savedTo ? (
          <div style={{ fontSize: 13, color: C.textFaint }}>✓ Saved to On Deck</div>
        ) : (
          <button onClick={handleOnDeck} style={{ background: 'none', border: `1px solid ${C.blue}`, borderRadius: 20, color: C.blue, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>🍹 On Deck</button>
        ))}
      </div>

      {showRefineCTA && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          {tweakDone && <div style={{ fontSize: 12, color: C.green, marginBottom: 6 }}>✓ Refined</div>}
          <button onClick={() => setTweakModalOpen(true)}
            style={{ background: 'none', border: `1px solid ${C.gold}66`, borderRadius: 20, color: C.gold, fontSize: 12, fontWeight: 500, padding: '5px 12px', cursor: 'pointer' }}>
            ✦ Refine this
          </button>
        </div>
      )}
      {tweakModalOpen && (
        <TweakModal
          suggestion={displayed}
          user={user}
          whiteboardId={whiteboardId}
          recipeNodeId={recipeNodeIdRef.current}
          inventoryText={inventoryText}
          tried={tried}
          notes={notes}
          onClose={() => setTweakModalOpen(false)}
          onApply={handleTweakApply}
        />
      )}
    </div>
  )
}

const EXPLORE_LOADING_MSGS = [
  'Searching published cocktail recipes…',
  'Crafting original ideas for your ingredients…',
  'Matching against your inventory…',
  'Almost there…',
]

function TemplateInfoSheet({ template, onClose }) {
  const t = TEMPLATE_MAP[template]
  if (!t) return null
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 900, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: '100%', maxWidth: 600, background: C.bg, borderRadius: '16px 16px 0 0', padding: '20px 20px 36px', maxHeight: '80vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t.emoji} {t.name}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 20, cursor: 'pointer', padding: 0, marginLeft: 'auto', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ fontSize: 14, color: C.gold, marginBottom: 10, lineHeight: 1.5 }}>{t.formula}</div>
        <div style={{ fontSize: 14, color: C.text, marginBottom: 14, lineHeight: 1.5 }}>{t.mechanic}</div>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}><b style={{ color: C.textFaint }}>Also:</b> {t.examples.join(', ')}</div>
      </div>
    </div>
  )
}

function ExplorationsScreen({ inventory, inventoryText, inventoryTags, onSaveOnDeck, user, pendingRestore, onRestoreConsumed, onBackToInProgress, onOpenWhiteboard }) {
  const [step, setStep] = useState('ingredients')
  const [navStack, setNavStack] = useState([])
  const [selected, setSelected] = useState([])
  const [template, setTemplate] = useState(null)
  const [frozen, setFrozen] = useState(false)
  const [na, setNa] = useState(false)
  const [lowABV, setLowABV] = useState(false)
  const [templatePickerLoading, setTemplatePickerLoading] = useState(false)
  const [infoSheetTemplate, setInfoSheetTemplate] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [isFeedbackLoading, setIsFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState(null)
  const [feedbackBanner, setFeedbackBanner] = useState(false)
  const feedbackBannerRef = useRef(null)
  const stepRef = useRef(step)
  const [history, setHistory] = useState([])
  const [originalsFetched, setOriginalsFetched] = useState(false)
  const [seeMoreLoading, setSeeMoreLoading] = useState(false)
  const [seeMoreError, setSeeMoreError] = useState(null)
  const [moreIdeasExist, setMoreIdeasExist] = useState(false)
  const [morePublishedExist, setMorePublishedExist] = useState(false)
  const [seeMorePublishedLoading, setSeeMorePublishedLoading] = useState(false)
  const [seeMorePublishedError, setSeeMorePublishedError] = useState(null)
  const [viaSurpriseMe, setViaSurpriseMe] = useState(false)
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0)
  const [affinityData, setAffinityData] = useState({})
  const [affinityLoading, setAffinityLoading] = useState(false)
  const [affinityError, setAffinityError] = useState(null)
  // Session 6: contextual layer — generated fresh per exploration, never
  // persisted. Array in the same order as `selected`, one entry per ingredient.
  const [contextualAffinityData, setContextualAffinityData] = useState([])
  const [contextualAffinityLoading, setContextualAffinityLoading] = useState(false)
  const [contextualAffinityError, setContextualAffinityError] = useState(null)
  const [categoryDrawer, setCategoryDrawer] = useState(null) // { category, bottles } | null
  const [combinationData, setCombinationData] = useState(null)
  const [combinationLoading, setCombinationLoading] = useState(false)
  const [combinationError, setCombinationError] = useState(null)
  const [showIngredientAdder, setShowIngredientAdder] = useState(false)
  const [adderQuery, setAdderQuery] = useState('')
  const [currentWhiteboardId, setCurrentWhiteboardId] = useState(null)
  const [currentIngredientsNodeId, setCurrentIngredientsNodeId] = useState(null)
  const [currentRecipeListNodeId, setCurrentRecipeListNodeId] = useState(null)
  const [currentRecipeNodeIds, setCurrentRecipeNodeIds] = useState({})
  const [continueFromNodeId, setContinueFromNodeId] = useState(null)
  const [autoExpandRecipeNodeId, setAutoExpandRecipeNodeId] = useState(null)
  const [restoreNodeData, setRestoreNodeData] = useState({}) // recipe_name → { nodeId, tried, notes } — siblings only, see buildContinueRestore
  const [autoExpandNodeData, setAutoExpandNodeData] = useState(null) // { tried, notes } for the auto-expanded card, keyed by node id not name

  useEffect(() => {
    const load = async () => {
      if (user) {
        const cutoff = new Date(Date.now() - EXPLORATION_HISTORY_MAX_AGE_MS).toISOString()
        await supabase.from('explorations_history').delete().eq('user_id', user.id).lt('updated_at', cutoff)
        const { data } = await supabase
          .from('explorations_history')
          .select('search_key,primary_ingredients,template,frozen,na,low_abv,result,updated_at')
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

  useEffect(() => { stepRef.current = step }, [step])

  useEffect(() => {
    if (!pendingRestore) return
    setSelected(pendingRestore.primary_ingredients || [])
    setTemplate(pendingRestore.template || null)
    setFrozen(pendingRestore.frozen || false)
    setNa(pendingRestore.na || false)
    setLowABV(pendingRestore.low_abv || false)
    setResult(pendingRestore.result || null)
    setError(null); setFeedback(''); setFeedbackError(null); setFeedbackBanner(false); setOriginalsFetched(true); setMoreIdeasExist(false); setMorePublishedExist(false)
    setCurrentWhiteboardId(pendingRestore.whiteboardId || null)
    setCurrentIngredientsNodeId(pendingRestore.ingredientsNodeId || null)
    setCurrentRecipeListNodeId(pendingRestore.restoreRecipeListNodeId || null)
    setContinueFromNodeId(pendingRestore.continueFromNodeId || null)
    setAutoExpandRecipeNodeId(pendingRestore.restoreRecipeNodeId || null)
    const nd = pendingRestore.restoreNodeData || {}
    setRestoreNodeData(nd)
    setAutoExpandNodeData(pendingRestore.autoExpandNodeData || null)
    // Pre-populate node IDs so RecipeCards bind to existing rows instead of creating duplicates
    const restoredNodeIds = {}
    Object.entries(nd).forEach(([name, data]) => { if (data.nodeId) restoredNodeIds[name] = data.nodeId })
    setCurrentRecipeNodeIds(restoredNodeIds)
    // Seed navStack so Back from restored results → whiteboard → In Progress
    const stack = []
    if (pendingRestore.whiteboardId) {
      stack.push({ type: 'inProgress' })
      stack.push({ type: 'whiteboard', id: pendingRestore.whiteboardId })
    }
    setNavStack(stack)
    setStep(pendingRestore.resumeStep || (pendingRestore.result ? 'results' : 'ingredients'))
    onRestoreConsumed?.()
  }, [pendingRestore]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 'loading') return
    setLoadingMsgIdx(0)
    const id = setInterval(() => setLoadingMsgIdx(prev => (prev + 1) % EXPLORE_LOADING_MSGS.length), 8000)
    return () => clearInterval(id)
  }, [step])

  const upsertHistory = (ingredients, searchTemplate, searchFrozen, searchLowABV, searchNa, searchResult) => {
    const entry = {
      search_key: makeExplorationKey(ingredients, searchTemplate, searchFrozen, searchLowABV, searchNa),
      primary_ingredients: [...ingredients].sort(),
      template: searchTemplate,
      frozen: searchFrozen,
      low_abv: searchLowABV,
      na: searchNa,
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
    setTemplate(entry.template)
    setFrozen(entry.frozen)
    setLowABV(entry.low_abv)
    setNa(entry.na)
    setResult(entry.result)
    setError(null)
    setFeedback('')
    setFeedbackError(null)
    setFeedbackBanner(false)
    setOriginalsFetched(true)
    setMoreIdeasExist(false)
    setMorePublishedExist(false)
    goToStep('results')
  }

  // Navigation helpers — use these instead of bare setStep so all transitions go through the stack.
  // goToStep pushes the current step and moves forward; goBack pops and moves backward.
  const goToStep = (newStep) => {
    const fromStep = stepRef.current
    setNavStack(prev => [...prev, fromStep])
    setStep(newStep)
  }

  const goBack = () => {
    const top = navStack[navStack.length - 1]
    if (!top) {
      onBackToInProgress?.()
      return
    }
    setNavStack(prev => prev.slice(0, -1))
    if (typeof top === 'object') {
      if (top.type === 'whiteboard') onOpenWhiteboard?.(top.id)
      else if (top.type === 'inProgress') onBackToInProgress?.()
    } else {
      setStep(top)
    }
  }

  // Tier-1 only: fires the published-recipe (web search) call and shows it immediately.
  // Riffs/originals are not generated here — see handleSeeMore for the on-demand tier-2/3
  // call. Returns { data, wbId, recipeListNodeId, ingredientsNodeId } (or null on full
  // failure) so callers that need to chain a tier-2/3 fetch (Quick Build, Surprise Me —
  // Decision B) can do so without depending on state that hasn't re-rendered yet.
  const handleExplore = async (opts = {}) => {
    const activeTemplate = opts.template ?? template
    const activeContinueFromNodeId = opts.continueFromNodeId !== undefined ? opts.continueFromNodeId : continueFromNodeId
    const fromStep = opts.fromStep !== undefined ? opts.fromStep : stepRef.current
    setNavStack(prev => [...prev, fromStep])
    setStep('loading')
    setOriginalsFetched(false)
    setSeeMoreError(null)
    setMoreIdeasExist(false)
    setMorePublishedExist(false)
    setSeeMorePublishedError(null)
    setViaSurpriseMe(!!opts.viaSurpriseMe)
    setRestoreNodeData({})
    setAutoExpandNodeData(null)
    try {
      const modifiers = { frozen, lowABV, na }
      const data = stripCiteTags(await analyzeExplorationsRecipes(selected, activeTemplate, modifiers, inventoryText))
      setResult(data)
      setMorePublishedExist(data?.more_published_exist === true)
      setStep('results')
      let wbId = null
      let recipeListNodeId = null
      let ingredientsNodeId = null
      if (!data.incompatible) {
        upsertHistory(selected, activeTemplate, frozen, lowABV, na, data)
        if (user) {
          try {
            const now = new Date().toISOString()
            wbId = currentWhiteboardId
            let recipeListParentId = activeContinueFromNodeId
            ingredientsNodeId = currentIngredientsNodeId

            if (!wbId) {
              const { data: wb } = await supabase
                .from('exploration_whiteboards')
                .insert({ user_id: user.id, title: selected.join(' + '), status: 'active', last_touched_at: now })
                .select('id').single()
              wbId = wb?.id
              setCurrentWhiteboardId(wbId ?? null)
              if (wbId) {
                const { data: ingNode } = await supabase
                  .from('exploration_nodes')
                  .insert({ whiteboard_id: wbId, parent_node_id: null, node_type: 'ingredients', payload: { selected: selected.map(s => String(s)), template: activeTemplate, frozen: Boolean(frozen), low_abv: Boolean(lowABV), na: Boolean(na) } })
                  .select('id').single()
                recipeListParentId = ingNode?.id ?? null
                ingredientsNodeId = ingNode?.id ?? null
                setCurrentIngredientsNodeId(ingredientsNodeId)
              }
            }

            if (wbId) {
              const recipes = JSON.parse(JSON.stringify(data.suggestions || []))
              const { data: listNode } = await supabase
                .from('exploration_nodes')
                .insert({ whiteboard_id: wbId, parent_node_id: recipeListParentId ?? null, node_type: 'recipe_list', payload: { recipes } })
                .select('id').single()
              recipeListNodeId = listNode?.id ?? null
              setCurrentRecipeListNodeId(recipeListNodeId)
              setContinueFromNodeId(null)

              const recipeNodeIds = {}
              if (recipeListNodeId && recipes.length > 0) {
                const settled = await Promise.allSettled(
                  recipes.map(recipe =>
                    supabase.from('exploration_nodes')
                      .insert({ whiteboard_id: wbId, parent_node_id: recipeListNodeId, node_type: 'recipe', payload: { recipe } })
                      .select('id').single()
                  )
                )
                recipes.forEach((recipe, i) => {
                  const r = settled[i]
                  if (r.status === 'fulfilled' && r.value?.data?.id && recipe.recipe_name) {
                    recipeNodeIds[recipe.recipe_name] = r.value.data.id
                  }
                })
              }
              setCurrentRecipeNodeIds(recipeNodeIds)

              await supabase.from('exploration_whiteboards').update({ last_touched_at: now }).eq('id', wbId)
            }
          } catch (err) {
            console.warn('[whiteboard] failed to write whiteboard:', err.message)
          }
        }
      }
      return { data, wbId, recipeListNodeId, ingredientsNodeId }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStep('error')
      return null
    }
  }

  // On-demand tier-2/3 (riff/original) generation, triggered by the "See more ideas →"
  // CTA — or pre-fired automatically right after tier-1 for Quick Build/Surprise Me
  // (Decision B), which pass wbId/recipeListNodeId/baseSuggestions explicitly since
  // handleExplore's state updates haven't rendered yet at that point in the chain.
  // Mirrors the old handlePartialRetry's merge-and-persist pattern.
  const handleSeeMore = async (opts = {}) => {
    if (seeMoreLoading) return
    const activeTemplate = opts.template ?? template
    const wbId = opts.whiteboardId !== undefined ? opts.whiteboardId : currentWhiteboardId
    const recipeListNodeId = opts.recipeListNodeId !== undefined ? opts.recipeListNodeId : currentRecipeListNodeId
    const baseSuggestions = opts.baseSuggestions ?? result?.suggestions ?? []
    setSeeMoreLoading(true)
    setSeeMoreError(null)
    try {
      const modifiers = { frozen, lowABV, na }
      // Prior riffs/originals only — tier-1 names aren't relevant to tier-2/3 distinctness.
      // Bare recipe names aren't enough here: the model invents a new name each round, so
      // a name alone can't tell it "this swap was already used" — it has to see the actual
      // ingredients to judge substantive overlap (e.g. two different-round suggestions both
      // swapping in Cardamaro under different invented names). Include each excluded
      // suggestion's full ingredient list so distinctness is judged on the swap, not the name.
      const excludeNames = baseSuggestions
        .filter(s => s.origin === 'riff' || s.origin === 'original')
        .map(s => `${s.recipe_name} (${(s.recipe || []).map(r => r.ingredient).join(', ')})`)
      const freshData = stripCiteTags(await analyzeExplorationsOriginals(selected, activeTemplate, modifiers, inventoryText, excludeNames))
      const newSuggestions = freshData?.suggestions || []
      const mergedSuggestions = sortByOriginRank([...baseSuggestions, ...newSuggestions])

      setResult(prev => ({
        ...(prev || {}),
        incompatible: false,
        suggestions: mergedSuggestions,
        flavor_profile_note: prev?.flavor_profile_note || freshData.flavor_profile_note || null,
        pairs_well_with: prev?.pairs_well_with || freshData.pairs_well_with || null,
        cross_template_suggestion: prev?.cross_template_suggestion || freshData.cross_template_suggestion || null,
      }))
      setOriginalsFetched(true)
      setMoreIdeasExist(freshData?.more_ideas_exist === true)

      if (user && wbId && recipeListNodeId && newSuggestions.length > 0) {
        try {
          const settled = await Promise.allSettled(
            newSuggestions.map(recipe =>
              supabase.from('exploration_nodes')
                .insert({ whiteboard_id: wbId, parent_node_id: recipeListNodeId, node_type: 'recipe', payload: { recipe } })
                .select('id').single()
            )
          )
          const newIds = {}
          newSuggestions.forEach((recipe, i) => {
            const r = settled[i]
            if (r.status === 'fulfilled' && r.value?.data?.id && recipe.recipe_name) {
              newIds[recipe.recipe_name] = r.value.data.id
            }
          })
          setCurrentRecipeNodeIds(prev => ({ ...prev, ...newIds }))
          await supabase.from('exploration_nodes').update({ payload: { recipes: mergedSuggestions } }).eq('id', recipeListNodeId)
          await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', wbId)
        } catch (err) {
          console.warn('[whiteboard] failed to persist see-more suggestions:', err.message)
        }
      }
      return { mergedSuggestions }
    } catch (err) {
      console.warn('[see more] failed:', err.message)
      setSeeMoreError('Could not load more ideas. Please try again.')
      return null
    } finally {
      setSeeMoreLoading(false)
    }
  }

  // On-demand tier-1 (published) re-search, triggered by the "See More Published
  // Recipes →" CTA (only rendered when more_published_exist is true). Passes the
  // already-surfaced published names so the model finds genuinely different recipes
  // instead of re-finding the same ones. Mirrors handleSeeMore's merge-and-persist
  // pattern, but appends into the sorted list and re-derives more_published_exist from
  // this call's own response, so the CTA can persist across several rounds and
  // disappear once the canon is exhausted.
  const handleSeeMorePublished = async () => {
    if (seeMorePublishedLoading) return
    const baseSuggestions = result?.suggestions ?? []
    setSeeMorePublishedLoading(true)
    setSeeMorePublishedError(null)
    try {
      const modifiers = { frozen, lowABV, na }
      const excludeNames = baseSuggestions.filter(s => s.origin === 'published').map(s => s.recipe_name)
      const freshData = stripCiteTags(await analyzeExplorationsRecipes(selected, template, modifiers, inventoryText, excludeNames))
      const newSuggestions = freshData?.suggestions || []
      const mergedSuggestions = sortByOriginRank([...baseSuggestions, ...newSuggestions])

      setResult(prev => ({
        ...(prev || {}),
        incompatible: false,
        suggestions: mergedSuggestions,
        flavor_profile_note: prev?.flavor_profile_note || freshData.flavor_profile_note || null,
        pairs_well_with: prev?.pairs_well_with || freshData.pairs_well_with || null,
        cross_template_suggestion: prev?.cross_template_suggestion || freshData.cross_template_suggestion || null,
      }))
      setMorePublishedExist(freshData?.more_published_exist === true)

      if (user && currentWhiteboardId && currentRecipeListNodeId && newSuggestions.length > 0) {
        try {
          const settled = await Promise.allSettled(
            newSuggestions.map(recipe =>
              supabase.from('exploration_nodes')
                .insert({ whiteboard_id: currentWhiteboardId, parent_node_id: currentRecipeListNodeId, node_type: 'recipe', payload: { recipe } })
                .select('id').single()
            )
          )
          const newIds = {}
          newSuggestions.forEach((recipe, i) => {
            const r = settled[i]
            if (r.status === 'fulfilled' && r.value?.data?.id && recipe.recipe_name) {
              newIds[recipe.recipe_name] = r.value.data.id
            }
          })
          setCurrentRecipeNodeIds(prev => ({ ...prev, ...newIds }))
          await supabase.from('exploration_nodes').update({ payload: { recipes: mergedSuggestions } }).eq('id', currentRecipeListNodeId)
          await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', currentWhiteboardId)
        } catch (err) {
          console.warn('[whiteboard] failed to persist see-more-published suggestions:', err.message)
        }
      }
      return { mergedSuggestions }
    } catch (err) {
      console.warn('[see more published] failed:', err.message)
      setSeeMorePublishedError('Could not load more published recipes. Please try again.')
      return null
    } finally {
      setSeeMorePublishedLoading(false)
    }
  }

  const reset = () => { setStep('ingredients'); setNavStack([]); setSelected([]); setTemplate(null); setFrozen(false); setNa(false); setLowABV(false); setResult(null); setError(null); setFeedback(''); setFeedbackError(null); setFeedbackBanner(false); setOriginalsFetched(false); setSeeMoreLoading(false); setSeeMoreError(null); setMoreIdeasExist(false); setMorePublishedExist(false); setSeeMorePublishedLoading(false); setSeeMorePublishedError(null); setViaSurpriseMe(false); setAffinityData({}); setAffinityError(null); setAffinityLoading(false); setContextualAffinityData([]); setContextualAffinityLoading(false); setContextualAffinityError(null); setCategoryDrawer(null); setCombinationData(null); setCombinationLoading(false); setCombinationError(null); setShowIngredientAdder(false); setAdderQuery(''); setCurrentWhiteboardId(null); setCurrentIngredientsNodeId(null); setCurrentRecipeListNodeId(null); setCurrentRecipeNodeIds({}); setContinueFromNodeId(null); setAutoExpandRecipeNodeId(null); setRestoreNodeData({}); setAutoExpandNodeData(null) }

  const handleFeedback = async () => {
    if (!feedback.trim() || isFeedbackLoading) return
    setIsFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const previousNames = (result?.suggestions || []).map(s => s.recipe_name)
      const data = await refineExplorations(selected, template, { frozen, lowABV, na }, inventoryText, previousNames, feedback.trim())
      setResult(data)
      setOriginalsFetched(true) // refine already returns a full revised set; the tier-1/2 split no longer applies
      setMoreIdeasExist(false)
      setMorePublishedExist(false)
      setFeedback('')
      setFeedbackBanner(true)
      setTimeout(() => feedbackBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
      setTimeout(() => setFeedbackBanner(false), 4000)
      upsertHistory(selected, template, frozen, lowABV, na, data)
    } catch (err) {
      setFeedbackError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setIsFeedbackLoading(false)
    }
  }

  const ensureAffinityData = async () => {
    setAffinityLoading(true)
    setAffinityError(null)
    let map = {}
    try {
      const normalizedSelected = selected.map(s => s.trim().toLowerCase())

      // Step 1: Check what's already in the affinities table
      const { data, error } = await supabase
        .from('ingredient_affinities')
        .select('ingredient_name, flavor_affinities, spirit_tags, flavor_tags')
        .in('ingredient_name', normalizedSelected)
      if (error) throw error

      ;(data || []).forEach(row => { map[row.ingredient_name] = row })

      // Step 2: Find selected ingredients with no affinity data
      const missing = selected.filter(s => !map[s.trim().toLowerCase()])

      // Step 3: Generate on-demand for any not in the table
      if (missing.length > 0) {
        try {
          const ingredients = missing.map(name => ({ name, category: '', notes: '', own_flavors: map[name.trim().toLowerCase()]?.flavor_tags || [] }))
          const response = await fetch('/api/backfill-affinities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ingredients }),
          })
          if (response.ok) {
            const { data: freshData } = await supabase
              .from('ingredient_affinities')
              .select('ingredient_name, flavor_affinities, spirit_tags, flavor_tags')
              .in('ingredient_name', missing.map(s => s.trim().toLowerCase()))
            ;(freshData || []).forEach(row => { map[row.ingredient_name] = row })
          } else {
            console.warn('[affinities] on-demand generation failed for:', missing)
          }
        } catch (onDemandErr) {
          console.warn('[affinities] on-demand error:', onDemandErr.message)
        }
      }

      setAffinityData(map)
    } catch (err) {
      console.warn('[affinities] failed to load affinity data:', err.message)
      map = {}
      setAffinityData({})
      setAffinityError('Could not load affinity data. You can still continue.')
    } finally {
      setAffinityLoading(false)
    }
    return map
  }

  // Session 6: the base-layer fetch used to happen here, before the template
  // was even chosen — which is exactly why affinities couldn't know about
  // template or modifiers. It now fires from the template step instead (see
  // handleContinueToAffinities). This transition is now just navigation.
  const handleNextFromIngredients = () => {
    goToStep('template')
  }

  // Fires when the user leaves the template step for the affinities step —
  // the first point in the flow where template and modifiers are both known.
  // Blocks briefly on the base layer (a fast indexed read, so this stays
  // close to instant) then navigates; the contextual layer is fired after
  // navigating and streams in on its own, per Change 3.
  const handleContinueToAffinities = async () => {
    const baseMap = await ensureAffinityData()
    setContextualAffinityData([])
    setContextualAffinityError(null)
    setContextualAffinityLoading(true)
    goToStep('affinities')
    fetchContextualAffinities(baseMap)
  }

  const fetchContextualAffinities = async (baseMap) => {
    try {
      const modifiers = { frozen, lowABV, na }
      const data = await analyzeContextualAffinities(selected, template, modifiers, baseMap)
      const forbidden = TEMPLATE_SIGNATURES[template]?.forbiddenRoles || []
      const entries = (data?.ingredients || []).map(entry => ({
        contextual_prose: entry?.contextual_prose || null,
        spirit_categories: (entry?.spirit_categories || []).filter(c => c?.category && !forbidden.includes(c.role)),
        flavor_categories: (entry?.flavor_categories || []).filter(c => c?.category && !forbidden.includes(c.role)),
      }))
      setContextualAffinityData(entries)
    } catch (err) {
      // Change 3: contextual failure degrades to the base layer, never an
      // error state — the screen stays fully useful either way.
      console.warn('[contextual affinities] failed:', err.message)
      setContextualAffinityError(err.message)
    } finally {
      setContextualAffinityLoading(false)
    }
  }

  // Quick Build and Surprise Me skip the deliberate template-picker flow entirely, so
  // per Decision B they pre-fire the tier-2/3 "See more" call right after tier-1 completes
  // — preserving their existing "full set immediately" behavior instead of adopting the
  // tier-1-first-then-opt-in flow used by the deliberate template-picker path.
  const handleQuickBuild = async () => {
    const fromStep = stepRef.current
    setTemplatePickerLoading(true)
    setStep('loading') // covers the template-resolution round trip too, not just generation
    try {
      const affinityMap = await ensureAffinityData()
      const resolved = await resolveTemplate(selected, affinityMap)
      setTemplate(resolved)
      const tier1 = await handleExplore({ template: resolved, fromStep })
      if (tier1 && !tier1.data.incompatible) {
        await handleSeeMore({ template: resolved, whiteboardId: tier1.wbId, recipeListNodeId: tier1.recipeListNodeId, baseSuggestions: tier1.data.suggestions || [] })
      }
    } finally {
      setTemplatePickerLoading(false)
    }
  }

  const handleSurpriseMe = async () => {
    const fromStep = stepRef.current
    setTemplatePickerLoading(true)
    setStep('loading') // covers the template-resolution round trip too, not just generation
    try {
      // Session 6: Surprise Me lives on the template step, which no longer
      // pre-fetches affinity data on the way in (see handleNextFromIngredients)
      // — resolveTemplate still needs it to pick a template, so fetch it here
      // directly, same as Quick Build already does.
      const affinityMap = await ensureAffinityData()
      const resolved = await resolveTemplate(selected, affinityMap)
      setTemplate(resolved)
      const tier1 = await handleExplore({ template: resolved, fromStep, viaSurpriseMe: true })
      if (tier1 && !tier1.data.incompatible) {
        await handleSeeMore({ template: resolved, whiteboardId: tier1.wbId, recipeListNodeId: tier1.recipeListNodeId, baseSuggestions: tier1.data.suggestions || [] })
      }
    } finally {
      setTemplatePickerLoading(false)
    }
  }

  const handleCrossTemplateSuggestion = async (suggestedTemplate) => {
    setTemplate(suggestedTemplate)
    // Attach the new recipe_list as a sibling under the same ingredients node
    // (not nested under the current recipe_list) so the whiteboard shows two
    // parallel builds from the same seed ingredients rather than a chain.
    await handleExplore({ template: suggestedTemplate, continueFromNodeId: currentIngredientsNodeId })
  }

  const analyzeCombination = async (ingredients, currentAffinityData) => {
    const affinityMap = currentAffinityData || affinityData
    setCombinationLoading(true)
    setCombinationError(null)
    try {
      const affinityContext = ingredients.map(ing => {
        const row = affinityMap[ing.trim().toLowerCase()]
        if (!row) return `${ing}: no affinity data available`
        return `${ing}: ${row.flavor_affinities} Spirit affinities: ${row.spirit_tags?.join(', ')}. Flavor affinities: ${row.flavor_tags?.join(', ')}.`
      }).join('\n\n')

      const prompt = `You are an expert craft bartender analyzing a combination of ingredients for cocktail creation.

SELECTED INGREDIENTS: ${ingredients.join(', ')}

KNOWN AFFINITY DATA:
${affinityContext}

Based on these ingredients and their affinity profiles, provide a combination analysis in this exact JSON format:
{
  "combined_profile": "2-3 sentences describing the combined flavor profile of these ingredients together — what character the drink will have, what mood or occasion it suits",
  "additional_suggestions": [
    { "name": "ingredient name", "reason": "one brief sentence why it would work" }
  ]
}

Rules:
- additional_suggestions should contain 1-2 items max — non-alcoholic modifiers, citrus, herbs, syrups, or specific spirits that would meaningfully complete this combination. Do NOT suggest ingredients already selected.
- Return ONLY valid JSON, no other text.`

      const parsed = await callClaude({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      })
      setCombinationData(parsed)
      if (stepRef.current === 'affinities' || stepRef.current === 'combination') setStep('combination')
    } catch (err) {
      console.warn('[combination] analysis failed:', err.message)
      setCombinationError('Could not analyze this combination. You can still proceed with Quick Build.')
      if (stepRef.current === 'affinities' || stepRef.current === 'combination') setStep('combination')
    } finally {
      setCombinationLoading(false)
    }
  }

  const handleAddAndAnalyze = async (ingredientName) => {
    const trimmed = ingredientName.trim()
    if (!trimmed || selected.map(s => s.trim().toLowerCase()).includes(trimmed.toLowerCase())) return
    const newSelected = [...selected, trimmed]
    setSelected(newSelected)
    setShowIngredientAdder(false)
    setAdderQuery('')

    // Navigate immediately so user sees loading state rather than the expanded affinities screen
    setCombinationLoading(true)
    setCombinationData(null)
    setCombinationError(null)
    goToStep('combination')

    const normNew = trimmed.trim().toLowerCase()
    const mergedAffinityData = { ...affinityData }

    if (!mergedAffinityData[normNew]) {
      try {
        const { data } = await supabase
          .from('ingredient_affinities')
          .select('ingredient_name, flavor_affinities, spirit_tags, flavor_tags')
          .eq('ingredient_name', normNew)
          .single()
        if (data) {
          mergedAffinityData[normNew] = data
        } else {
          const response = await fetch('/api/backfill-affinities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ingredients: [{ name: trimmed, category: '', notes: '', own_flavors: mergedAffinityData[normNew]?.flavor_tags || [] }] }),
          })
          if (response.ok) {
            const { data: freshData } = await supabase
              .from('ingredient_affinities')
              .select('ingredient_name, flavor_affinities, spirit_tags, flavor_tags')
              .eq('ingredient_name', normNew)
              .single()
            if (freshData) mergedAffinityData[normNew] = freshData
          }
        }
      } catch (_) {
        // Non-blocking — analyzeCombination handles missing affinity data gracefully
      }
    }

    setAffinityData(mergedAffinityData)
    await analyzeCombination(newSelected, mergedAffinityData)
  }

  // Undoes an ingredient add from the affinities screen — the × on the
  // "Exploring:" chips. Keeps contextualAffinityData aligned with `selected`
  // by index, and clears combinationData/Error since it was computed for a
  // set that included the ingredient being removed. Never removes the last
  // ingredient — an exploration needs at least one.
  const handleRemoveIngredient = (ingName) => {
    if (selected.length <= 1) return
    const idx = selected.findIndex(s => s === ingName)
    if (idx === -1) return
    setSelected(prev => prev.filter((_, i) => i !== idx))
    setContextualAffinityData(prev => prev.filter((_, i) => i !== idx))
    setCombinationData(null)
    setCombinationError(null)
  }

  if (step === 'ingredients') return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-0.02em', marginBottom: 4 }}>Explorations</div>
      <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 24, lineHeight: 1.55 }}>Pick up to 2 ingredients and we'll suggest cocktails you can make — or inspire you to try something new.</div>
      <IngredientSearch inventory={inventory} selected={selected}
        onSelect={ing => { setSelected(p => [...p, ing]); setTemplate(null); setFrozen(false); setNa(false) }}
        onRemove={ing => { setSelected(p => p.filter(i => i !== ing)); setTemplate(null); setFrozen(false); setNa(false) }} />
      {selected.length > 0 && (
        <>
          <button onClick={handleNextFromIngredients} disabled={affinityLoading || templatePickerLoading}
            style={{ width: '100%', background: C.gold, border: 'none', borderRadius: 10, color: '#0f0f0f', fontWeight: 700, fontSize: 15, padding: '13px', cursor: (affinityLoading || templatePickerLoading) ? 'default' : 'pointer', marginTop: 24, opacity: (affinityLoading || templatePickerLoading) ? 0.7 : 1 }}>
            {affinityLoading ? 'Loading…' : 'Choose a Template →'}
          </button>
          <button onClick={handleQuickBuild} disabled={affinityLoading || templatePickerLoading}
            style={{ width: '100%', background: 'none', border: 'none', color: C.textFaint, fontWeight: 600, fontSize: 13, padding: '10px 0 0', cursor: (affinityLoading || templatePickerLoading) ? 'default' : 'pointer', display: 'block', textAlign: 'center' }}>
            {templatePickerLoading ? 'Building…' : '✨ Quick Build'}
          </button>
        </>
      )}
    </div>
  )

  if (step === 'affinities') {
    const selectedNorm = selected.map(s => s.trim().toLowerCase())
    const titleCase = s => s.replace(/(^|\s)(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase())

    // Session 4's inventory_tags, not string-matching on bottle names — a
    // category is "owned" if some in-stock bottle's generic_type or an alias
    // matches it exactly. Ownership never filters what's shown, only marks it.
    const getOwnedBottlesForCategory = (category) => {
      const normCat = category.trim().toLowerCase()
      if (!inventory || !inventoryTags) return []
      return inventory.filter(item => {
        if (item.oos) return false
        const tag = inventoryTags[item.spirit.trim().toLowerCase()]
        if (!tag) return false
        if ((tag.generic_type || '').trim().toLowerCase() === normCat) return true
        return (tag.aliases || []).some(a => (a || '').trim().toLowerCase() === normCat)
      })
    }

    // Spirit chips always open the drawer, owned or not — the drawer itself
    // always offers "Add <category>" as a generic option, with owned bottles
    // (if any) listed below it as a refinement. The whole chip is one tap
    // target regardless of ownership; the dot is a status indicator only.
    const renderSpiritChip = (category) => {
      const owned = getOwnedBottlesForCategory(category)
      const isOwned = owned.length > 0
      const label = titleCase(category)
      return (
        <span key={category}
          onClick={() => setCategoryDrawer({ category: label, bottles: owned })}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, fontSize: 13, fontWeight: 500, margin: '3px 4px 3px 0', background: isOwned ? C.gold + '22' : C.surface, border: `1px solid ${isOwned ? C.gold + '44' : C.border}`, color: isOwned ? C.gold : C.textMuted, cursor: 'pointer' }}>
          {label}
          {isOwned && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.gold, flexShrink: 0 }} />}
        </span>
      )
    }

    // Flavor chips have no bottles behind them — nothing to drill into, so
    // tapping adds the flavor directly as a second exploration ingredient.
    const renderFlavorChip = (category) => (
      <span key={category}
        onClick={() => handleAddAndAnalyze(titleCase(category))}
        style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 20, fontSize: 13, fontWeight: 500, margin: '3px 4px 3px 0', background: C.surface, border: `1px solid ${C.border}`, color: C.textMuted, cursor: 'pointer' }}>
        {titleCase(category)}
      </span>
    )

    // The template and any active modifiers vanish from view after the
    // template step otherwise, even though they're the biggest determinant
    // of what gets generated on this very screen.
    const activeModifierLabels = [lowABV && 'Low-ABV', na && 'NA', frozen && 'Frozen'].filter(Boolean)

    return (
      <div>
        <style>{`@keyframes bcshimmer { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
        <button onClick={goBack} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>← Back</button>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 24 }}>
          <span style={{ fontSize: 13, color: C.textMuted }}>Exploring:</span>
          {selected.map(ingName => (
            <span key={ingName} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: C.gold + '22', border: `1px solid ${C.gold}55`, borderRadius: 20, color: C.gold, fontSize: 13, padding: '3px 8px 3px 12px', fontWeight: 500 }}>
              {ingName}
              {selected.length > 1 && (
                <button onClick={() => handleRemoveIngredient(ingName)} style={{ background: 'none', border: 'none', color: C.gold, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 0 0 2px' }}>×</button>
              )}
            </span>
          ))}
          {template && <span style={{ fontSize: 13, color: C.textMuted }}>· {TEMPLATE_MAP[template]?.name || template}</span>}
          {activeModifierLabels.length > 0 && <span style={{ fontSize: 13, color: C.textMuted }}>· {activeModifierLabels.join(', ')}</span>}
        </div>
        {affinityError && (
          <div style={{ background: C.amber + '15', border: `1px solid ${C.amber}44`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: C.amber, marginBottom: 20 }}>{affinityError}</div>
        )}
        {selected.map((ingName, i) => {
          const normName = ingName.trim().toLowerCase()
          const row = affinityData[normName]
          const contextual = contextualAffinityData[i]
          // Streaming in: contextual replaces base wholesale per section once it
          // arrives (Change 3) — a swap, not a merge, since contextual is what
          // carries the role tags the forbidden-category filter depends on.
          const resolving = contextualAffinityLoading && !contextual
          const prose = contextual?.contextual_prose || row?.flavor_affinities || 'No affinity data available for this ingredient.'
          const spiritCats = contextual ? (contextual.spirit_categories || []).map(c => c.category) : (row?.spirit_tags || [])
          const flavorCats = contextual ? (contextual.flavor_categories || []).map(c => c.category) : (row?.flavor_tags || [])
          const shimmerStyle = resolving ? { animation: 'bcshimmer 1.6s ease-in-out infinite' } : {}
          return (
            <div key={normName}>
              {i > 0 && <div style={{ borderTop: `1px solid ${C.border}`, margin: '20px 0' }} />}
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.gold, marginBottom: 12 }}>{ingName}</div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 16, minHeight: 52, boxSizing: 'border-box', ...shimmerStyle }}>
                <div style={{ fontSize: 14, color: prose ? C.textMuted : C.textFaint, lineHeight: 1.55 }}>
                  {prose}
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Pairs Well With — Spirits</div>
              <div style={{ marginBottom: 16, ...shimmerStyle }}>
                {spiritCats.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    {spiritCats.map(renderSpiritChip)}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: C.textFaint }}>No spirit affinities available</div>
                )}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Pairs Well With — Flavors</div>
              <div style={{ marginBottom: 8, ...shimmerStyle }}>
                {flavorCats.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    {flavorCats.map(renderFlavorChip)}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: C.textFaint }}>No flavor tags available</div>
                )}
              </div>
            </div>
          )
        })}
        {categoryDrawer && (
          <CategoryBottlesDrawer
            category={categoryDrawer.category}
            bottles={categoryDrawer.bottles}
            onAddGeneric={() => { setCategoryDrawer(null); handleAddAndAnalyze(categoryDrawer.category) }}
            onAddBottle={(spirit) => { setCategoryDrawer(null); handleAddAndAnalyze(spirit) }}
            onClose={() => setCategoryDrawer(null)}
          />
        )}
        {!showIngredientAdder ? (
          <button
            onClick={() => setShowIngredientAdder(true)}
            style={{ width: '100%', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontWeight: 600, fontSize: 15, padding: '13px', cursor: 'pointer', marginTop: 8 }}>
            + Add an Ingredient
          </button>
        ) : (
          <div style={{ marginTop: 8, position: 'relative' }}>
            <input
              autoFocus
              value={adderQuery}
              onChange={e => setAdderQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && adderQuery.trim()) { setShowIngredientAdder(false); setAdderQuery(''); handleAddAndAnalyze(adderQuery.trim()) } }}
              placeholder="Type an ingredient..."
              style={{ width: '100%', background: C.surface, border: `1px solid ${C.gold}`, borderRadius: 10, color: C.text, fontSize: 15, padding: '13px 16px', boxSizing: 'border-box', outline: 'none' }}
            />
            {adderQuery.trim().length > 0 && (() => {
              const q = adderQuery.toLowerCase().trim()
              const sugs = (inventory || []).filter(i => !selectedNorm.includes(i.spirit.trim().toLowerCase()) && i.spirit.toLowerCase().includes(q)).slice(0, 6)
              const exact = sugs.some(s => s.spirit.toLowerCase() === q)
              return (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#1c1c1c', border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 20, overflow: 'hidden', marginTop: 4 }}>
                  {sugs.map(item => (
                    <div key={item.spirit} onClick={() => { setShowIngredientAdder(false); setAdderQuery(''); handleAddAndAnalyze(item.spirit) }}
                      style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                      onMouseEnter={e => e.currentTarget.style.background = C.border}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <span>{item.spirit}</span>
                      {item.category && <span style={{ fontSize: 11, color: C.textFaint }}>{item.category}</span>}
                    </div>
                  ))}
                  {!exact && (
                    <div onClick={() => { setShowIngredientAdder(false); setAdderQuery(''); handleAddAndAnalyze(adderQuery.trim()) }}
                      style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, color: C.textMuted, borderTop: sugs.length ? `1px solid ${C.border}` : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = C.border}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      Use &quot;{adderQuery.trim()}&quot; →
                    </div>
                  )}
                </div>
              )
            })()}
            <button
              onClick={() => { setShowIngredientAdder(false); setAdderQuery('') }}
              style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 13, cursor: 'pointer', marginTop: 8, padding: '4px 0', display: 'block' }}>
              Cancel
            </button>
          </div>
        )}
        <button onClick={() => handleExplore()}
          style={{ width: '100%', background: C.gold, border: `1px solid ${C.gold}`, borderRadius: 10, color: '#0f0f0f', fontWeight: 700, fontSize: 15, padding: '13px', cursor: 'pointer', marginTop: 24, transition: 'background 0.15s, color 0.15s' }}>
          ✨ Build
        </button>
      </div>
    )
  }

  if (step === 'combination') {
    return (
      <div>
        <button onClick={() => { setCombinationData(null); setCombinationError(null); goBack() }} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>← Back</button>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 24 }}>
          Building: <span style={{ color: C.gold }}>{selected.join(' + ')}</span>
        </div>

        {combinationLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <style>{`@keyframes bcspin3 { to { transform: rotate(360deg); } }`}</style>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: `3px solid ${C.border}`, borderTopColor: C.gold, animation: 'bcspin3 0.8s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 14, color: C.textFaint }}>Analyzing combination…</div>
          </div>
        ) : combinationError ? (
          <div style={{ background: C.amber + '15', border: `1px solid ${C.amber}44`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: C.amber, marginBottom: 20 }}>
            {combinationError}
          </div>
        ) : combinationData ? (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Combined Profile</div>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
              <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.55 }}>{combinationData.combined_profile}</div>
            </div>

            {combinationData.additional_suggestions?.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 8 }}>Consider Adding</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                  {combinationData.additional_suggestions.map((s, i) => (
                    <div
                      key={i}
                      onClick={() => handleAddAndAnalyze(s.name)}
                      style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: C.textFaint, lineHeight: 1.4 }}>{s.reason}</div>
                      </div>
                      <span style={{ color: C.gold, fontSize: 18, flexShrink: 0 }}>+</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : null}

        <button
          onClick={() => !combinationLoading && handleExplore()}
          disabled={combinationLoading}
          style={{ width: '100%', background: C.gold, border: 'none', borderRadius: 10, color: '#0f0f0f', fontWeight: 700, fontSize: 15, padding: '13px', cursor: combinationLoading ? 'default' : 'pointer', marginTop: 8, opacity: combinationLoading ? 0.5 : 1, transition: 'opacity 0.2s' }}>
          Build Recipes →
        </button>
      </div>
    )
  }

  if (step === 'template') {
    const showNaChip = selected.some(s => isLikelyNonAlcoholic(s, inventory))
    const showFrozenChip = !!(template && TEMPLATE_MAP[template]?.frozenEligible)
    const chip = (active, label, onClick) => (
      <button key={label} onClick={onClick}
        style={{ background: active ? C.gold + '22' : C.surface, border: `1px solid ${active ? C.gold + '66' : C.border}`, borderRadius: 20, color: active ? C.gold : C.text, fontSize: 13, fontWeight: active ? 600 : 400, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background 0.15s, color 0.15s' }}>
        {label}{active && ' ✓'}
      </button>
    )
    return (
      <div>
        <button onClick={goBack} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>← Back</button>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>Choose a Template</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>Exploring: <span style={{ color: C.gold }}>{selected.join(' + ')}</span></div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          {chip(lowABV, 'Low-ABV', () => setLowABV(v => !v))}
          {showNaChip && chip(na, 'NA', () => setNa(v => !v))}
          {showFrozenChip && chip(frozen, 'Frozen', () => setFrozen(v => !v))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
          {TEMPLATES.map(t => {
            const active = template === t.id
            return (
              <button key={t.id} onClick={() => setTemplate(t.id)}
                style={{ position: 'relative', background: active ? C.gold + '22' : C.surface, border: `1px solid ${active ? C.gold + '66' : C.border}`, borderRadius: 10, color: active ? C.gold : C.text, padding: '14px 12px', cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s, color 0.15s' }}>
                <span onClick={e => { e.stopPropagation(); setInfoSheetTemplate(t.id) }}
                  style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: `1px solid ${C.border}`, color: C.textFaint, fontSize: 11, cursor: 'pointer' }}>i</span>
                <div style={{ fontSize: 22, marginBottom: 6 }}>{t.emoji}</div>
                <div style={{ fontSize: 14, fontWeight: active ? 700 : 600, lineHeight: 1.25, marginBottom: 2, paddingRight: 18 }}>{t.name}</div>
                <div style={{ fontSize: 12, color: active ? C.gold : C.textFaint }}>{t.subtitle}</div>
              </button>
            )
          })}
        </div>

        <button onClick={handleSurpriseMe} disabled={templatePickerLoading}
          style={{ width: '100%', background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textMuted, fontWeight: 600, fontSize: 14, padding: '12px', cursor: templatePickerLoading ? 'default' : 'pointer', marginBottom: 16, opacity: templatePickerLoading ? 0.6 : 1 }}>
          🎲 Surprise Me
        </button>

        <button onClick={handleContinueToAffinities} disabled={!template || affinityLoading}
          style={{ width: '100%', background: template ? C.gold : C.surface, border: `1px solid ${template ? C.gold : C.border}`, borderRadius: 10, color: template ? '#0f0f0f' : C.textFaint, fontWeight: 700, fontSize: 15, padding: '13px', cursor: (template && !affinityLoading) ? 'pointer' : 'default', opacity: affinityLoading ? 0.7 : 1, transition: 'background 0.15s, color 0.15s' }}>
          {affinityLoading ? 'Loading…' : 'Continue →'}
        </button>

        {infoSheetTemplate && <TemplateInfoSheet template={infoSheetTemplate} onClose={() => setInfoSheetTemplate(null)} />}
      </div>
    )
  }

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
      <div style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 10, padding: '14px 16px', fontSize: 14, color: C.red, marginBottom: 16 }}>
        {error || 'Something went wrong generating suggestions.'}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={() => handleExplore()} style={{ background: C.gold, border: 'none', borderRadius: 8, color: '#0f0f0f', fontWeight: 700, fontSize: 13, padding: '9px 18px', cursor: 'pointer' }}>Retry</button>
        <button onClick={reset} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 13, cursor: 'pointer', padding: 0 }}>Start over</button>
      </div>
    </div>
  )

  if (step === 'results' && result) {
    const backLabel = navStack[navStack.length - 1]?.type === 'whiteboard' ? '← Whiteboard' : '← Back'

    if (result.incompatible) return (
      <div>
        <button onClick={goBack} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>{backLabel}</button>
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
        <button onClick={goBack} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, padding: '8px 0', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 5 }}>{backLabel}</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 700, color: C.text }}>{selected.join(' + ')}</div>
          <button onClick={reset} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textMuted, fontSize: 12, padding: '5px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Start over</button>
        </div>
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
                {canMake.map((s, i) => { const isAutoExpand = autoExpandRecipeNodeId != null && s.__autoExpandNodeId === autoExpandRecipeNodeId; const nd = isAutoExpand ? autoExpandNodeData : restoreNodeData[s.recipe_name]; return <RecipeCard key={i} suggestion={stripInternalFields(s)} primaryIngredients={selected} onSaveOnDeck={onSaveOnDeck} user={user} whiteboardId={currentWhiteboardId} recipeListNodeId={currentRecipeListNodeId} recipeNodeIds={currentRecipeNodeIds} autoExpand={isAutoExpand} restoreRecipeNodeId={isAutoExpand ? autoExpandRecipeNodeId : null} initialTried={nd?.tried || false} initialNotes={nd?.notes || ''} inventoryText={inventoryText} /> })}
              </div>
            </div>
          )}
          {worthBuying.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.amber, marginBottom: 12 }}>Shopping Required ({worthBuying.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {worthBuying.map((s, i) => { const isAutoExpand = autoExpandRecipeNodeId != null && s.__autoExpandNodeId === autoExpandRecipeNodeId; const nd = isAutoExpand ? autoExpandNodeData : restoreNodeData[s.recipe_name]; return <RecipeCard key={i} suggestion={stripInternalFields(s)} primaryIngredients={selected} onSaveOnDeck={onSaveOnDeck} user={user} whiteboardId={currentWhiteboardId} recipeListNodeId={currentRecipeListNodeId} recipeNodeIds={currentRecipeNodeIds} autoExpand={isAutoExpand} restoreRecipeNodeId={isAutoExpand ? autoExpandRecipeNodeId : null} initialTried={nd?.tried || false} initialNotes={nd?.notes || ''} inventoryText={inventoryText} /> })}
              </div>
            </div>
          )}
        </div>
        {/* Suppressed after Surprise Me (Change 5) — the model already picked the template
            there, so a redirect a moment later reads as second-guessing its own choice. */}
        {!viaSurpriseMe && result.cross_template_suggestion && TEMPLATE_MAP[result.cross_template_suggestion.template] && (
          <div onClick={() => handleCrossTemplateSuggestion(result.cross_template_suggestion.template)}
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
                These ingredients are the base of the classic {result.cross_template_suggestion.drink_name}
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 7px', color: C.textMuted }}>
                  {TEMPLATE_MAP[result.cross_template_suggestion.template].emoji} {TEMPLATE_MAP[result.cross_template_suggestion.template].name}
                </span>
              </div>
              <div style={{ fontSize: 12, color: C.textFaint, lineHeight: 1.4 }}>{result.cross_template_suggestion.reason}</div>
            </div>
            <span style={{ color: C.gold, fontSize: 18, flexShrink: 0 }}>→</span>
          </div>
        )}
        {!originalsFetched && (result.suggestions || []).length === 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: C.textFaint, marginBottom: 12, lineHeight: 1.5 }}>
            No published recipes matched — a riff or an original might still work well.
          </div>
        )}
        {/* Tier-1 re-search — only rendered when the model has told us, this batch, that
            genuine published matches remain beyond what it returned. Persists across
            several taps and disappears once more_published_exist goes false. */}
        {morePublishedExist && (
          <div style={{ marginBottom: 12 }}>
            <button onClick={() => handleSeeMorePublished()} disabled={seeMorePublishedLoading}
              style={{ width: '100%', background: 'none', border: `1px dashed ${C.border}`, borderRadius: 10, color: C.gold, fontSize: 13, fontWeight: 600, padding: '12px 16px', cursor: seeMorePublishedLoading ? 'default' : 'pointer', opacity: seeMorePublishedLoading ? 0.6 : 1 }}>
              {seeMorePublishedLoading ? 'Searching for more…' : 'See more published recipes →'}
            </button>
            {seeMorePublishedError && <div style={{ fontSize: 13, color: C.red, marginTop: 8 }}>{seeMorePublishedError}</div>}
          </div>
        )}
        {/* Tier-2/3 — visible before the first fetch (we don't know yet what's there), then
            gated on more_ideas_exist so it persists across taps and disappears once the
            model has said it's shown everything worth showing. */}
        {(!originalsFetched || moreIdeasExist) && (
          <div style={{ marginBottom: 24 }}>
            <button onClick={() => handleSeeMore()} disabled={seeMoreLoading}
              style={{ width: '100%', background: 'none', border: `1px dashed ${C.border}`, borderRadius: 10, color: C.gold, fontSize: 13, fontWeight: 600, padding: '12px 16px', cursor: seeMoreLoading ? 'default' : 'pointer', opacity: seeMoreLoading ? 0.6 : 1 }}>
              {seeMoreLoading ? 'Finding more ideas…' : 'See more ideas →'}
            </button>
            {seeMoreError && <div style={{ fontSize: 13, color: C.red, marginTop: 8 }}>{seeMoreError}</div>}
          </div>
        )}
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

function WhiteboardsTab({ user, onOpen }) {
  const [whiteboards, setWhiteboards] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) { setLoading(false); return }
    const load = async () => {
      setLoading(true)
      try {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        await supabase.from('exploration_whiteboards')
          .update({ status: 'archived' })
          .eq('user_id', user.id).eq('status', 'active').lt('last_touched_at', cutoff)
        const { data } = await supabase.from('exploration_whiteboards')
          .select('id, title, last_touched_at')
          .eq('user_id', user.id).eq('status', 'active')
          .order('last_touched_at', { ascending: false })
        setWhiteboards(data || [])
      } catch (err) {
        console.warn('[whiteboards] load error:', err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user?.id])

  const handleArchive = async (id) => {
    try {
      await supabase.from('exploration_whiteboards').update({ status: 'archived' }).eq('id', id)
      setWhiteboards(prev => prev.filter(w => w.id !== id))
    } catch (err) {
      console.warn('[whiteboards] archive error:', err.message)
    }
  }

  if (!user) return <div style={{ fontSize: 14, color: C.textFaint, textAlign: 'center', padding: '40px 0' }}>Sign in to use Whiteboards.</div>
  if (loading) return <div style={{ fontSize: 14, color: C.textFaint, textAlign: 'center', padding: '40px 0' }}>Loading…</div>
  if (whiteboards.length === 0) return <div style={{ fontSize: 14, color: C.textFaint, textAlign: 'center', padding: '40px 0' }}>No active whiteboards. Complete an exploration to create one.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {whiteboards.map(wb => (
        <div key={wb.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wb.title}</div>
            <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>{relativeTime(wb.last_touched_at)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button onClick={() => onOpen(wb.id)}
              style={{ background: C.gold, border: 'none', borderRadius: 20, color: '#0f0f0f', fontSize: 12, fontWeight: 700, padding: '5px 14px', cursor: 'pointer' }}>
              Open
            </button>
            <button onClick={() => handleArchive(wb.id)}
              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 20, color: C.textFaint, fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>
              Archive
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function WhiteboardScreen({ whiteboardId, onBack, onContinueFromNode }) {
  const [nodes, setNodes] = useState([])
  const [whiteboard, setWhiteboard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [nodeNotes, setNodeNotes] = useState({})
  const [triedMap, setTriedMap] = useState({})
  const [viewConvMessages, setViewConvMessages] = useState(null)
  const nodeNotesRef = useRef(nodeNotes)
  useEffect(() => { nodeNotesRef.current = nodeNotes }, [nodeNotes])
  const dirtyNoteIdsRef = useRef(new Set())

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const [{ data: wb }, { data: nds }] = await Promise.all([
          supabase.from('exploration_whiteboards').select('*').eq('id', whiteboardId).single(),
          supabase.from('exploration_nodes').select('*').eq('whiteboard_id', whiteboardId).order('created_at', { ascending: true }),
        ])
        setWhiteboard(wb)
        const allNodes = (nds || []).filter(n => n.whiteboard_id === whiteboardId)
        setNodes(allNodes)
        const notesMap = {}
        const triedInit = {}
        allNodes.forEach(n => {
          if (n.notes) notesMap[n.id] = n.notes
          if (n.tried) triedInit[n.id] = true
        })
        setNodeNotes(notesMap)
        setTriedMap(triedInit)
      } catch (err) {
        console.warn('[whiteboard] load error:', err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [whiteboardId])

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleSaveNotes = async (nodeId, notes) => {
    dirtyNoteIdsRef.current.delete(nodeId)
    try {
      await supabase.from('exploration_nodes').update({ notes }).eq('id', nodeId)
      await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', whiteboardId)
    } catch (err) {
      console.warn('[whiteboard] note save failed:', err.message)
    }
  }

  // Notes only save on textarea blur — if the user navigates away (Back, tab switch, etc.)
  // without blurring first, flush whatever's still marked dirty so it isn't silently lost.
  useEffect(() => {
    return () => {
      // Intentionally reading refs at unmount time (not a snapshot) — these are plain
      // mutable data refs updated on every keystroke/save, not DOM node refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      dirtyNoteIdsRef.current.forEach(id => {
        const value = nodeNotesRef.current[id]
        if (value !== undefined) supabase.from('exploration_nodes').update({ notes: value }).eq('id', id).then()
      })
    }
  }, [])

  const handleToggleTried = async (nodeId) => {
    const next = !triedMap[nodeId]
    const triedAt = next ? new Date().toISOString() : null
    setTriedMap(prev => ({ ...prev, [nodeId]: next }))
    try {
      await supabase.from('exploration_nodes').update({ tried: next, tried_at: triedAt }).eq('id', nodeId)
      await supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', whiteboardId)
    } catch (err) {
      console.warn('[whiteboard] tried toggle failed:', err.message)
      setTriedMap(prev => ({ ...prev, [nodeId]: !next }))
    }
  }

  const buildContinueRestore = (node) => {
    const nodeMap = {}
    nodes.forEach(n => { nodeMap[n.id] = n })

    const selfAndAncestors = []
    let cur = node
    while (cur) { selfAndAncestors.unshift(cur); cur = cur.parent_node_id ? nodeMap[cur.parent_node_id] : null }

    const ingredientsNode = selfAndAncestors.find(n => n.node_type === 'ingredients')
    const recipeListNode = selfAndAncestors.find(n => n.node_type === 'recipe_list')

    const selected = ingredientsNode?.payload?.selected || []
    const template = ingredientsNode?.payload?.template || null
    const frozen = ingredientsNode?.payload?.frozen || false
    const lowABV = ingredientsNode?.payload?.low_abv || false
    const na = ingredientsNode?.payload?.na || false

    const isIngredients = node.node_type === 'ingredients'
    const restoreRecipeListNodeId = isIngredients ? null : (node.node_type === 'recipe_list' ? node.id : recipeListNode?.id ?? null)
    const baseRecipes = isIngredients ? null : (node.node_type === 'recipe_list' ? node.payload?.recipes : recipeListNode?.payload?.recipes) || []

    // For tweak nodes: replace the original recipe in the list with the tweaked version
    // so the card opens showing the tweaked result ready to tweak further.
    let suggestions = baseRecipes
    let autoExpandRecipeName = null
    let restoreRecipeNodeId = null
    if (node.node_type === 'recipe') {
      autoExpandRecipeName = node.payload?.recipe?.recipe_name ?? null
      restoreRecipeNodeId = node.id
    } else if (node.node_type === 'tweak') {
      const recipeAncestor = selfAndAncestors.find(n => n.node_type === 'recipe')
      const originalName = recipeAncestor?.payload?.recipe?.recipe_name
      const tweakedResult = node.payload?.result
      if (originalName && tweakedResult && Array.isArray(baseRecipes) && baseRecipes.length > 0) {
        // Spread tweakedResult but never wipe out recipe_name if the tweaked version doesn't have one
        const safeTweaked = tweakedResult.recipe_name
          ? tweakedResult
          : { ...tweakedResult, recipe_name: originalName }
        suggestions = baseRecipes.map(r => r.recipe_name === originalName ? { ...r, ...safeTweaked } : r)
      }
      // Prefer tweaked name; fall back to original so the card can still be found
      autoExpandRecipeName = tweakedResult?.recipe_name || originalName || null
      // The tweak node is its own identity going forward — Tried/notes/further tweaks
      // must attach to it, not to the ancestor recipe node it happened to spring from.
      restoreRecipeNodeId = node.id
    }

    // Tag the one suggestion entry that should auto-expand with its resolved node id
    // directly, so the results screen can pick it out by id instead of by recipe_name —
    // the last name-based lookup in this path (a tweak that keeps its parent's name would
    // otherwise be indistinguishable from the parent by name alone).
    if (restoreRecipeNodeId && autoExpandRecipeName && Array.isArray(suggestions)) {
      let marked = false
      suggestions = suggestions.map(r => {
        if (!marked && r.recipe_name === autoExpandRecipeName) {
          marked = true
          return { ...r, __autoExpandNodeId: restoreRecipeNodeId }
        }
        return r
      })
    }

    const result = isIngredients ? null : { incompatible: false, incompatibility_reason: null, flavor_profile_note: null, pairs_well_with: null, cross_template_suggestion: null, suggestions }

    // Build a map of recipe_name → { nodeId, tried, notes } from SIBLING recipe nodes only
    // (children of the recipe_list). This hydrates the non-auto-expanded RecipeCards in the
    // list and prevents duplicate node inserts. It intentionally excludes the auto-expanded
    // card below — that one is looked up by node id, never by name, so a tweak that keeps its
    // parent's recipe_name can never collide with (or be masked by) a sibling entry here.
    const restoreNodeData = {}
    if (restoreRecipeListNodeId) {
      nodes
        .filter(n => n.parent_node_id === restoreRecipeListNodeId && n.node_type === 'recipe')
        .forEach(n => {
          const name = n.payload?.recipe?.recipe_name
          if (name) restoreNodeData[name] = { nodeId: n.id, tried: triedMap[n.id] ?? !!n.tried, notes: nodeNotes[n.id] ?? n.notes ?? '' }
        })
    }
    // Auto-expanded card's tried/notes are resolved directly by node id (never by name) so a
    // tweak node sharing its parent's recipe_name is structurally impossible to collide with.
    const autoExpandNode = restoreRecipeNodeId ? nodeMap[restoreRecipeNodeId] : null
    const autoExpandNodeData = autoExpandNode
      ? { tried: triedMap[autoExpandNode.id] ?? !!autoExpandNode.tried, notes: nodeNotes[autoExpandNode.id] ?? autoExpandNode.notes ?? '' }
      : null

    return {
      primary_ingredients: selected,
      template,
      frozen,
      low_abv: lowABV,
      na,
      result,
      resumeStep: isIngredients ? 'ingredients' : 'results',
      whiteboardId,
      ingredientsNodeId: ingredientsNode?.id ?? null,
      continueFromNodeId: node.id,
      restoreRecipeListNodeId,
      autoExpandRecipeName,
      restoreRecipeNodeId,
      restoreNodeData,
      autoExpandNodeData,
    }
  }

  const NODE_LABELS = { ingredients: 'Ingredients', recipe_list: 'Recipes', recipe: 'Recipe', tweak: 'Tweak' }

  const nodeSummary = (node) => {
    if (node.node_type === 'ingredients') {
      const parts = [node.payload?.selected?.join(', ')]
      if (node.payload?.template) parts.push(TEMPLATE_MAP[node.payload.template]?.name || node.payload.template)
      return parts.filter(Boolean).join(' · ')
    }
    if (node.node_type === 'recipe_list') return `${(node.payload?.recipes || []).length} recipes generated`
    if (node.node_type === 'recipe') return node.payload?.recipe?.recipe_name || 'Recipe'
    if (node.node_type === 'tweak') {
      if (node.payload?.tweak_label) return node.payload.tweak_label
      const p = node.payload?.prompt || ''
      return p.length > 60 ? p.slice(0, 60) + '…' : p
    }
    return node.node_type
  }

  const renderNodeDetail = (node) => {
    if (node.node_type === 'ingredients') {
      const modifierLabels = [
        node.payload?.frozen && 'Frozen',
        node.payload?.low_abv && 'Low-ABV',
        node.payload?.na && 'NA',
      ].filter(Boolean)
      return (
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>
          <div><b>Ingredients:</b> {node.payload?.selected?.join(', ')}</div>
          {node.payload?.template && <div><b>Template:</b> {TEMPLATE_MAP[node.payload.template]?.name || node.payload.template}</div>}
          {modifierLabels.length > 0 && <div><b>Modifiers:</b> {modifierLabels.join(', ')}</div>}
        </div>
      )
    }
    if (node.node_type === 'recipe_list') {
      // Read from the actual child 'recipe' nodes (real ids, real tried state) rather than
      // the list's own payload snapshot, so tried status shown here is never stale.
      const recipeChildren = (childrenMap[node.id] || []).filter(n => n.node_type === 'recipe')
      return (
      <div style={{ fontSize: 13, color: C.textMuted }}>
        {recipeChildren.map((n, i) => {
          const isTried = triedMap[n.id] ?? !!n.tried
          return (
            <div key={n.id} style={{ padding: '4px 0', borderBottom: i < recipeChildren.length - 1 ? `1px solid ${C.border}` : 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
              {isTried && <span style={{ color: C.green, fontSize: 12, flexShrink: 0 }}>✓</span>}
              {n.payload?.recipe?.recipe_name}
            </div>
          )
        })}
      </div>
      )
    }
    if (node.node_type === 'recipe') {
      const r = node.payload?.recipe || {}
      return (
        <RecipeCard
          suggestion={r}
          initialTried={!!triedMap[node.id]}
          initialNotes={nodeNotes[node.id] ?? node.notes ?? ''}
          showSaveButtons={false}
          showRefineCTA={false}
          onTriedToggle={(next, triedAt) => {
            setTriedMap(prev => ({ ...prev, [node.id]: next }))
            supabase.from('exploration_nodes').update({ tried: next, tried_at: triedAt }).eq('id', node.id).then()
            supabase.from('exploration_whiteboards').update({ last_touched_at: new Date().toISOString() }).eq('id', whiteboardId).then()
          }}
          onNotesSave={(value) => {
            setNodeNotes(prev => ({ ...prev, [node.id]: value }))
            handleSaveNotes(node.id, value)
          }}
        />
      )
    }
    if (node.node_type === 'tweak') {
      const tried = !!triedMap[node.id]
      const hasConv = node.payload?.conversation?.length > 0
      return (
      <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{ flex: 1 }}><b>Prompt:</b> "{node.payload?.prompt}"</div>
          <button
            onClick={(e) => { e.stopPropagation(); handleToggleTried(node.id) }}
            style={{ background: tried ? C.green + '22' : C.border + '66', border: `1px solid ${tried ? C.green : C.textFaint}`, borderRadius: 20, color: tried ? C.green : C.textMuted, fontSize: 12, fontWeight: tried ? 700 : 400, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s', flexShrink: 0 }}>
            {tried ? '✓ Tried' : 'Mark Tried'}
          </button>
        </div>
        {node.payload?.result?.recipe_name && (
          <div style={{ color: C.gold, fontWeight: 600, marginBottom: 4 }}>{node.payload.result.recipe_name}</div>
        )}
        {node.payload?.result?.summary && <div style={{ marginBottom: hasConv ? 6 : 10 }}>{node.payload.result.summary}</div>}
        {hasConv && (
          <button onClick={(e) => { e.stopPropagation(); setViewConvMessages(node.payload.conversation) }}
            style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 12, cursor: 'pointer', padding: '0 0 10px', textDecoration: 'underline' }}>
            View conversation →
          </button>
        )}
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textFaint, marginBottom: 6 }}>Tasting Notes</div>
        <textarea
          value={nodeNotes[node.id] ?? node.notes ?? ''}
          onChange={e => { setNodeNotes(prev => ({ ...prev, [node.id]: e.target.value })); dirtyNoteIdsRef.current.add(node.id) }}
          onBlur={e => handleSaveNotes(node.id, e.target.value)}
          placeholder="Add your tasting notes…"
          rows={3}
          style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 13, padding: '8px 10px', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
    )
    }
    return null
  }

  // Build parent→children map once so each node occupies exactly one position in the
  // tree, regardless of what parent_node_id values exist in the DB.
  const { treeRoots, childrenMap } = useMemo(() => {
    const ownNodes = nodes.filter(n => n.whiteboard_id === whiteboardId)
    const idSet = new Set(ownNodes.map(n => n.id))
    const childrenMap = {}
    ownNodes.forEach(n => { childrenMap[n.id] = [] })
    const roots = []
    ownNodes.forEach(n => {
      if (n.parent_node_id && idSet.has(n.parent_node_id)) {
        childrenMap[n.parent_node_id].push(n)
      } else {
        roots.push(n)
      }
    })
    return { treeRoots: roots, childrenMap }
  }, [nodes, whiteboardId])

  const renderNode = (node, depth) => {
    const isExpanded = expandedIds.has(node.id)
    const isRoot = !node.parent_node_id
    const children = childrenMap[node.id] || []
    const isTried = (node.node_type === 'recipe' || node.node_type === 'tweak') && (triedMap[node.id] ?? !!node.tried)

    return (
      <div key={node.id}>
        <div style={{ display: 'flex', marginLeft: depth * 16, paddingLeft: depth > 0 ? 12 : 0, borderLeft: depth > 0 ? `2px solid ${C.border}` : 'none' }}>
          <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 6, cursor: 'pointer' }}
            onClick={() => toggleExpand(node.id)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '2px 7px', color: C.textFaint, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                {NODE_LABELS[node.node_type] || node.node_type}
              </span>
              {isTried && <span style={{ color: C.green, fontSize: 12, flexShrink: 0 }}>✓</span>}
              <span style={{ fontSize: 13, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nodeSummary(node)}</span>
              <span style={{ color: C.textFaint, fontSize: 11, flexShrink: 0 }}>{isExpanded ? '▲' : '▼'}</span>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 10 }} onClick={e => e.stopPropagation()}>
                {renderNodeDetail(node)}
                {!isRoot && (
                  <button
                    onClick={() => onContinueFromNode(buildContinueRestore(node))}
                    style={{ marginTop: 12, background: 'none', border: `1px solid ${C.gold}`, borderRadius: 20, color: C.gold, fontSize: 12, fontWeight: 600, padding: '5px 14px', cursor: 'pointer' }}>
                    Continue from here →
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {children.map(child => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 14, cursor: 'pointer', padding: 0 }}>← Back</button>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-0.02em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {whiteboard?.title || 'Whiteboard'}
        </div>
      </div>

      {loading && <div style={{ fontSize: 14, color: C.textFaint, textAlign: 'center', padding: '40px 0' }}>Loading…</div>}

      {!loading && nodes.length === 0 && (
        <div style={{ fontSize: 14, color: C.textFaint, textAlign: 'center', padding: '40px 0' }}>No nodes yet.</div>
      )}

      {!loading && treeRoots.length > 0 && (
        <div style={{ paddingBottom: 40 }}>
          {treeRoots.map(root => renderNode(root, 0))}
        </div>
      )}

      {viewConvMessages && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 950, display: 'flex', alignItems: 'flex-end' }} onClick={() => setViewConvMessages(null)}>
          <div style={{ width: '100%', background: C.bg, borderRadius: '16px 16px 0 0', padding: '20px 20px 36px', maxHeight: '70vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1 }}>Tweak conversation</div>
              <button onClick={() => setViewConvMessages(null)} style={{ background: 'none', border: 'none', color: C.textFaint, fontSize: 20, cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {viewConvMessages.map((msg, i) => (
                <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', background: msg.role === 'user' ? C.gold + '22' : C.surface, border: `1px solid ${msg.role === 'user' ? C.gold + '44' : C.border}`, borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px', padding: '8px 12px', fontSize: 14, color: C.text, lineHeight: 1.5, display: 'block' }}>
                  {msg.content}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateScreen({ createSubTab, setCreateSubTab, inventory, inventoryText, inventoryTags, onSaveOnDeck, user, pendingRestore, onRestoreConsumed, onBackToInProgress, onOpenWhiteboard }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-0.02em', marginBottom: 16 }}>Create</div>
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 24 }}>
        {[{ id: 'new', label: 'New' }, { id: 'in_progress', label: 'In Progress' }].map(({ id, label }) => (
          <button key={id} onClick={() => setCreateSubTab(id)}
            style={{ background: 'none', border: 'none', borderBottom: createSubTab === id ? `2px solid ${C.gold}` : '2px solid transparent', color: createSubTab === id ? C.gold : C.textMuted, fontSize: 14, fontWeight: createSubTab === id ? 600 : 400, padding: '8px 16px', cursor: 'pointer', marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>
      {createSubTab === 'new' && (
        <ExplorationsScreen
          inventory={inventory}
          inventoryText={inventoryText}
          inventoryTags={inventoryTags}
          onSaveOnDeck={onSaveOnDeck}
          user={user}
          pendingRestore={pendingRestore}
          onRestoreConsumed={onRestoreConsumed}
          onBackToInProgress={onBackToInProgress}
          onOpenWhiteboard={onOpenWhiteboard}
        />
      )}
      {createSubTab === 'in_progress' && (
        <div>
          <WhiteboardsTab user={user} onOpen={onOpenWhiteboard} />
        </div>
      )}
    </div>
  )
}

function BottomTabBar({ screen, onTab }) {
  const tabs = [
    { id: 'create',    icon: '✨', label: 'Create' },
    { id: 'analyze',   icon: '🔍', label: 'Analyze' },
    { id: 'saved',     icon: '🍸', label: 'Saved' },
    { id: 'inventory', icon: '📦', label: 'Inventory' },
  ]
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: C.bg, borderTop: `1px solid ${C.border}`, display: 'flex', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {tabs.map(({ id, icon, label }) => {
        const active = screen === id || (id === 'create' && screen === 'whiteboard')
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

  // Inventory tags (Session 4: generic_type + aliases, keyed by item name)
  const [inventoryTags, setInventoryTags] = useState({})
  const [inventoryTagsError, setInventoryTagsError] = useState(null)
  const [tagSweepInProgress, setTagSweepInProgress] = useState(false)
  const [tagSweepProgress, setTagSweepProgress] = useState(null)
  const [tagSweepError, setTagSweepError] = useState(null)

  // Navigation
  const [screen, setScreen] = useState('create')
  const [createSubTab, setCreateSubTab] = useState('new')
  const [savedSubTab, setSavedSubTab] = useState('ondeck')
  const [pendingExplorationRestore, setPendingExplorationRestore] = useState(null)
  const [currentOpenWhiteboardId, setCurrentOpenWhiteboardId] = useState(null)

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

  useEffect(() => { shoppingListRef.current = shoppingList }, [shoppingList])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-shopping', JSON.stringify(shoppingList)) }, [shoppingList, user])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-favorites', JSON.stringify(favorites)) }, [favorites, user])
  useEffect(() => { if (!user) localStorage.setItem('bar-cart-to-make', JSON.stringify(toMake)) }, [toMake, user])

  // DB helpers
  const dbFavToLocal = (row) => ({
    id: row.id, recipeName: row.recipe_name, summary: row.summary,
    recipe: row.recipe || [], instructions: row.instructions || null,
    ingredients: row.ingredients || [], variations: row.variations || [],
    glassType: row.glass_type || null, note: row.notes || '', mode: row.mode,
    source: row.source || 'manual', origin: row.origin || null, originFlag: row.origin_flag || null,
    difficulty: row.difficulty || null, primaryIngredients: row.primary_ingredients || [],
    savedAt: row.saved_at,
  })

  const dbToMakeToLocal = (row) => ({
    id: row.id, recipeName: row.recipe_name, summary: row.summary,
    recipe: row.recipe || [], instructions: row.instructions || null,
    ingredients: row.ingredients || [], variations: row.variations || [],
    glassType: row.glass_type || null, mode: row.mode,
    source: row.source || 'manual', origin: row.origin || null, originFlag: row.origin_flag || null,
    difficulty: row.difficulty || null, primaryIngredients: row.primary_ingredients || [],
    savedAt: row.saved_at,
  })

  const migrateAndLoadData = async (u) => {
    const [{ data: favData }, { data: shopData }, { data: toMakeData }] = await Promise.all([
      supabase.from('favorites').select('*').eq('user_id', u.id).order('saved_at', { ascending: false }),
      supabase.from('shopping_list').select('*').eq('user_id', u.id).order('created_at', { ascending: true }),
      supabase.from('to_make').select('*').eq('user_id', u.id).order('saved_at', { ascending: false }),
    ])

    const hasCloudData = (favData?.length > 0) || (shopData?.length > 0) || (toMakeData?.length > 0)

    if (!hasCloudData) {
      const localFavs = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-favorites')) || [] } catch { return [] } })()
      const localShopping = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-shopping')) || [] } catch { return [] } })()
      const localToMake = (() => { try { return JSON.parse(localStorage.getItem('bar-cart-to-make')) || [] } catch { return [] } })()

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
    } else {
      if (favData) setFavorites(favData.map(dbFavToLocal))
      if (shopData) setShoppingList(shopData.map(r => ({ id: r.id, name: r.name })))
      if (toMakeData) setToMake(toMakeData.map(dbToMakeToLocal))
    }

    localStorage.removeItem('bar-cart-favorites')
    localStorage.removeItem('bar-cart-shopping')
    localStorage.removeItem('bar-cart-to-make')
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

      // Load inventory tags (generic_type + aliases) so the untagged count is
      // accurate on first paint. Surface a clear error rather than silently
      // showing zero untagged if the table is missing (unrun migration).
      try {
        const { data: tagRows, error: tagErr } = await supabase
          .from('inventory_tags')
          .select('item_name, generic_type, aliases, tagged_at')
        if (tagErr) throw tagErr
        const tagMap = {}
        for (const row of tagRows || []) tagMap[row.item_name] = row
        setInventoryTags(tagMap)
        setInventoryTagsError(null)
      } catch (err) {
        console.error('[inventory tags] load failed:', err.message)
        setInventoryTags({})
        setInventoryTagsError(err.message)
      }

      // Fire-and-forget affinity backfill for ingredients not yet analyzed
      ;(async () => {
        try {
          const excludedNorm = EXCLUDE_FROM_INVENTORY.map(e => e.trim().toLowerCase())
          const candidates = parsed
            .filter(item => !item.oos)
            .filter(item => !excludedNorm.some(ex => item.spirit.trim().toLowerCase().includes(ex)))
            .map(item => ({ name: item.spirit.trim(), normName: item.spirit.trim().toLowerCase(), category: item.category.trim(), notes: (item.notes || '').trim() }))

          // Dedupe by normalized name — backup bottles share an ingredient name but
          // need only one affinity entry. Two rows for the same name in one upsert
          // batch causes a Postgres ON CONFLICT error that fails the whole chunk.
          const seenNames = new Set()
          const dedupedCandidates = candidates.filter(c => {
            if (seenNames.has(c.normName)) return false
            seenNames.add(c.normName)
            return true
          })

          if (dedupedCandidates.length === 0) return

          const { data: existing, error: fetchErr } = await supabase
            .from('ingredient_affinities')
            .select('ingredient_name')
            .in('ingredient_name', dedupedCandidates.map(c => c.normName))

          if (fetchErr) { console.warn('[affinities] fetch error:', fetchErr.message); return }

          const existingSet = new Set((existing || []).map(r => r.ingredient_name))
          const newIngredients = dedupedCandidates.filter(c => !existingSet.has(c.normName))

          if (newIngredients.length === 0) { console.log('[affinities] all ingredients up to date'); return }

          const CHUNK_SIZE = 20
          const chunks = []
          for (let i = 0; i < newIngredients.length; i += CHUNK_SIZE) {
            chunks.push(newIngredients.slice(i, i + CHUNK_SIZE))
          }

          console.log(`[affinities] analyzing ${newIngredients.length} new ingredient(s) in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}`)
          setAffinityBackfillInProgress(true)

          let totalStored = 0
          let failedChunks = 0

          for (let i = 0; i < chunks.length; i++) {
            try {
              const response = await fetch('/api/backfill-affinities', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ingredients: chunks[i].map(c => ({ name: c.name, category: c.category, notes: c.notes })) }),
              })

              if (!response.ok) {
                const err = await response.json().catch(() => ({ error: response.statusText }))
                throw new Error(err.error || `HTTP ${response.status}`)
              }

              const result = await response.json()
              totalStored += result.count
              console.log(`[affinities] chunk ${i + 1}/${chunks.length}: stored ${result.count} ingredient(s)`)
            } catch (err) {
              failedChunks++
              console.warn(`[affinities] chunk ${i + 1}/${chunks.length} failed (continuing):`, err.message)
            }
          }

          console.log(`[affinities] backfill complete: ${totalStored}/${newIngredients.length} ingredient(s) stored${failedChunks > 0 ? ` (${failedChunks} chunk(s) failed)` : ''}`)
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

  // Inventory tags: untagged bottles, distinct vocabulary already in use.
  // Every inventory row is in scope — not just in-stock ones — since
  // generic_type is a durable product classification independent of stock.
  const untaggedBottles = useMemo(() => {
    if (!inventory) return []
    return inventory.filter(item => !inventoryTags[item.spirit.trim().toLowerCase()])
  }, [inventory, inventoryTags])

  const distinctGenericTypes = useMemo(() => (
    Array.from(new Set(Object.values(inventoryTags).map(t => t.generic_type).filter(Boolean))).sort()
  ), [inventoryTags])

  // Tags a batch of bottles (a full sweep, or a single per-bottle retag).
  // Chunked the same way the affinity backfill is, so one untagged bottle
  // makes exactly one API call (and one Claude call) rather than a full sweep.
  const runTagSweep = useCallback(async (bottlesToTag) => {
    if (!bottlesToTag || bottlesToTag.length === 0) return
    // Dedupe by normalized name before chunking — same reason as the affinity
    // backfill: backup bottles share a name but need only one tag row, and two
    // rows for the same name in one upsert batch is a hard Postgres ON CONFLICT
    // error that fails the whole chunk, not just that one row.
    const seenNames = new Set()
    const deduped = bottlesToTag.filter(b => {
      const key = b.spirit.trim().toLowerCase()
      if (seenNames.has(key)) return false
      seenNames.add(key)
      return true
    })
    setTagSweepError(null)
    setTagSweepInProgress(true)
    setTagSweepProgress({ done: 0, total: deduped.length })
    const CHUNK_SIZE = 20
    const chunks = []
    for (let i = 0; i < deduped.length; i += CHUNK_SIZE) chunks.push(deduped.slice(i, i + CHUNK_SIZE))
    let done = 0
    try {
      for (const chunk of chunks) {
        const response = await fetch('/api/tag-inventory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bottles: chunk.map(b => ({ name: b.spirit, category: b.category })) }),
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: response.statusText }))
          throw new Error(err.error || `HTTP ${response.status}`)
        }
        const result = await response.json()
        setInventoryTags(prev => {
          const next = { ...prev }
          for (const row of result.tags || []) next[row.item_name] = row
          return next
        })
        done += chunk.length
        setTagSweepProgress({ done, total: deduped.length })
      }
    } catch (err) {
      console.error('[tag sweep] failed:', err.message)
      setTagSweepError(err.message)
    } finally {
      setTagSweepInProgress(false)
    }
  }, [])

  // Manual dropdown edit — anon-key direct write, no service role. Restricted
  // to values already in use is enforced by the dropdown UI, not here.
  const setGenericTypeManually = useCallback(async (spiritName, newType) => {
    const key = spiritName.trim().toLowerCase()
    const { data, error } = await supabase
      .from('inventory_tags')
      .update({ generic_type: newType, tagged_at: new Date().toISOString() })
      .eq('item_name', key)
      .select()
      .single()
    if (error) { setTagSweepError(error.message); return }
    setInventoryTags(prev => ({ ...prev, [key]: data }))
  }, [])

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
    const { source = 'manual', origin = null, originFlag = null, difficulty = null, primaryIngredients = [] } = extras
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
          glass_type: res.glass_type || null, source, origin, origin_flag: originFlag,
          difficulty, primary_ingredients: primaryIngredients, saved_at: new Date().toISOString(),
        }).select().single()
        if (!error && data) setFavorites(prev => [dbFavToLocal(data), ...prev])
      }
    } else {
      setFavorites(prev => {
        const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
        if (existing >= 0) return prev.filter((_, i) => i !== existing)
        return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, instructions: res.instructions || null, ingredients: res.ingredients, variations: res.variations, glassType: res.glass_type || null, note: '', source, origin, originFlag, difficulty, primaryIngredients, savedAt: new Date().toISOString() }, ...prev]
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
    const { source = 'manual', origin = null, originFlag = null, difficulty = null, primaryIngredients = [] } = extras
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
          glass_type: res.glass_type || null, source, origin, origin_flag: originFlag,
          difficulty, primary_ingredients: primaryIngredients, saved_at: new Date().toISOString(),
        }).select().single()
        if (!error && data) setToMake(prev => [dbToMakeToLocal(data), ...prev])
      }
    } else {
      setToMake(prev => {
        const existing = prev.findIndex(f => f.recipeName === res.recipe_name)
        if (existing >= 0) return prev.filter((_, i) => i !== existing)
        return [{ id: Date.now(), recipeName: res.recipe_name, summary: res.summary, recipe: res.recipe, instructions: res.instructions || null, ingredients: res.ingredients, variations: res.variations, glassType: res.glass_type || null, source, origin, originFlag, difficulty, primaryIngredients, savedAt: new Date().toISOString() }, ...prev]
      })
    }
  }

  const removeFromToMake = async (id) => {
    if (user) await supabase.from('to_make').delete().eq('id', id)
    setToMake(prev => prev.filter(f => f.id !== id))
  }

  const viewToMake = (item) => {
    sourceScrollRef.current = window.scrollY
    setError(null); setAdjustmentNote(null)
    setResult({ recipe_name: item.recipeName, summary: item.summary, recipe: item.recipe, instructions: item.instructions, ingredients: item.ingredients, variations: item.variations, glass_type: item.glassType, origin: item.origin, origin_flag: item.originFlag, difficulty: item.difficulty, source: item.source })
    setResultSource('ondeck')
    setScreen('analyze')
  }

  const viewFavorite = (fav) => {
    sourceScrollRef.current = window.scrollY
    setError(null); setAdjustmentNote(null)
    setResult({ recipe_name: fav.recipeName, summary: fav.summary, recipe: fav.recipe, instructions: fav.instructions, ingredients: fav.ingredients, variations: fav.variations, glass_type: fav.glassType, origin: fav.origin, origin_flag: fav.originFlag, difficulty: fav.difficulty, source: fav.source })
    setResultSource('favorites')
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
    if (!result) return false
    setFeedbackLoading(true); setError(null)
    try {
      let revised
      if (lastRequestBody) {
        const feedbackBody = {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [
            ...stripInventoryFromMessages(lastRequestBody.messages),
            { role: 'assistant', content: JSON.stringify(result) },
            { role: 'user', content: `The user reviewed this analysis and provided this feedback: ${feedbackText}. Please revise your response accordingly and return the same JSON structure, with one additional field at the top level: "adjustment_note" — a 1-2 sentence plain English explanation of what specifically changed and why (e.g. "Scaled all amounts to a 4 oz total while maintaining the 1:1:1 Negroni ratio."). Do not include adjustment_note if nothing meaningful changed.` },
          ],
        }
        revised = await callClaude(feedbackBody)
        setLastRequestBody(feedbackBody)
        setAdjustmentNote(revised.adjustment_note || null)
      } else {
        revised = await tweakSingleSuggestion(result, feedbackText)
        setAdjustmentNote(null)
      }
      setError(null)
      setResult(processResult(revised))
      return true
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
      return false
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

  const inventoryText = inventory ? inventoryToText(inventory, inventoryTags) : ''

  const handleSaveOnDeckFromExploration = (suggestion, primaryIngredients) => {
    toggleToMake({ recipe_name: suggestion.recipe_name, summary: suggestion.summary, recipe: suggestion.recipe, instructions: suggestion.instructions, ingredients: suggestion.ingredients, variations: suggestion.variations || [], glass_type: suggestion.glass_type }, { source: 'Exploration', origin: suggestion.origin, originFlag: suggestion.origin_flag, difficulty: suggestion.difficulty, primaryIngredients })
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
        <InventoryScreen
          inventory={inventory}
          inStockCount={inStockCount}
          oosCount={oosCount}
          inventoryTags={inventoryTags}
          inventoryTagsError={inventoryTagsError}
          untaggedBottles={untaggedBottles}
          distinctGenericTypes={distinctGenericTypes}
          tagSweepInProgress={tagSweepInProgress}
          tagSweepProgress={tagSweepProgress}
          tagSweepError={tagSweepError}
          onTagSweep={runTagSweep}
          onSetGenericType={setGenericTypeManually}
        />
      )}

      {/* Screen: Shopping */}
      {screen === 'shopping' && (
        <ShoppingListScreen shoppingList={shoppingList} onRemove={removeFromShopping} onClear={clearShopping} />
      )}

      {/* Screen: Saved */}
      {screen === 'saved' && (
        <SavedScreen
          savedSubTab={savedSubTab} setSavedSubTab={setSavedSubTab}
          toMake={toMake} favorites={favorites}
          onRemoveToMake={removeFromToMake} onRemoveFavorite={removeFavorite}
          onViewToMake={viewToMake} onViewFavorite={viewFavorite}
          onUpdateNote={updateFavoriteNote}
        />
      )}

      {/* Screen: Create */}
      {screen === 'create' && (
        <CreateScreen
          createSubTab={createSubTab}
          setCreateSubTab={setCreateSubTab}
          inventory={inventory}
          inventoryText={inventoryText}
          inventoryTags={inventoryTags}
          onSaveOnDeck={handleSaveOnDeckFromExploration}
          user={user}
          pendingRestore={pendingExplorationRestore}
          onRestoreConsumed={() => setPendingExplorationRestore(null)}
          onBackToInProgress={() => setCreateSubTab('in_progress')}
          onOpenWhiteboard={id => { setCurrentOpenWhiteboardId(id); setScreen('whiteboard') }}
        />
      )}

      {/* Screen: Whiteboard */}
      {screen === 'whiteboard' && currentOpenWhiteboardId && (
        <WhiteboardScreen
          whiteboardId={currentOpenWhiteboardId}
          onBack={() => { setScreen('create'); setCreateSubTab('in_progress') }}
          onContinueFromNode={restore => { setPendingExplorationRestore(restore); setCreateSubTab('new'); setScreen('create') }}
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
                  ← Back to {resultSource === 'ondeck' ? 'On Deck' : 'Favorites'}
                </button>
              )}
              <Results
                result={result}
                adjustmentNote={adjustmentNote}
                shoppingList={shoppingList}
                onAddToList={addToShopping}
                favorites={favorites}
                onToggleFavorite={res => toggleFavorite(res, { source: res.source || analysisModeSource, origin: res.origin, originFlag: res.origin_flag, difficulty: res.difficulty })}
                toMake={toMake}
                onToggleToMake={res => toggleToMake(res, { source: res.source || analysisModeSource, origin: res.origin, originFlag: res.origin_flag, difficulty: res.difficulty })}
                onFeedback={handleFeedback}
                feedbackLoading={feedbackLoading}
                inventory={inventory}
                feedbackError={error}
              />
            </>
          )}
        </>
      )}

      <BottomTabBar screen={screen} onTab={setScreen} />
    </div>
  )
}
