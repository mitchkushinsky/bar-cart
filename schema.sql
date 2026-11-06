-- =============================================================================
-- Bar Cart — database schema snapshot (DOCUMENTATION ONLY — DO NOT RUN)
-- =============================================================================
--
-- This is a snapshot of what the production Supabase database currently
-- enforces, for the tables the app uses. It is NOT a migration: running it
-- would fail on existing tables, and it is not the source of truth — the
-- database is.
--
-- It is maintained BY HAND. Tables here are created and altered in the
-- Supabase SQL editor, not through migration files, so nothing keeps this
-- file in step automatically. Whenever the database changes (a column, a
-- constraint, a policy, an index, a grant), update this file in the same
-- session.
--
-- The schema comments at the top of src/App.jsx are a history of what was
-- asked for, not what exists: several policy names there differ from the
-- real ones below, and none of them mention the CHECK constraints.
--
-- Captured 2026-11-06 by read-only introspection run in the SQL editor
-- (information_schema.columns, pg_constraint, pg_policies, pg_indexes,
-- pg_class.relrowsecurity, information_schema.role_table_grants),
-- cross-checked against the PostgREST OpenAPI description. Covers Bar Cart's
-- eight tables only; the Supabase project is shared with another app whose
-- tables (rentals, renters, tasks, ...) are deliberately left out, as is
-- in_the_lab, which the app no longer uses.
--
-- -----------------------------------------------------------------------------
-- CONSTRAINTS THAT EACH COST A DEBUGGING CYCLE BY BEING INVISIBLE FROM THE REPO
-- -----------------------------------------------------------------------------
--
--   exploration_nodes_node_type_check
--     node_type must be one of a fixed list. A new node type is REFUSED by the
--     database until this constraint is altered. Session 30's 'creation' node
--     failed every insert on production until 'creation' was added.
--
--   to_make_user_id_recipe_name_key      UNIQUE (user_id, recipe_name)
--   favorites_user_id_recipe_name_key    UNIQUE (user_id, recipe_name)
--     One row per recipe name per user (Session 18). Saving a second recipe
--     under a name the user already has fails, so "keep both" must give the
--     copy a distinct recipe_name (the v2/v3 naming).
--
--   Also enforced and easy to miss: exploration_whiteboards_status_check
--   (status must be 'active' or 'archived').
--
-- -----------------------------------------------------------------------------
-- SUPABASE CHANGE, 30 OCT 2026: NEW TABLES NEED EXPLICIT GRANTS
-- -----------------------------------------------------------------------------
--
--   New tables in the public schema no longer get Data API access
--   automatically. A table created after that date must be granted to the
--   API roles explicitly, ON TOP OF enabling RLS and writing policies — RLS
--   alone leaves it unreachable from the app:
--
--     grant select, insert, update, delete on public.<table>
--       to anon, authenticated, service_role;
--
--   (Narrow the privileges and roles to what the table needs.) Tables that
--   existed before that date keep their existing grants.
--
-- -----------------------------------------------------------------------------
-- KNOWN ISSUES, RECORDED AND DELIBERATELY LEFT
-- -----------------------------------------------------------------------------
--
--   1. No index on exploration_nodes.whiteboard_id or
--      exploration_whiteboards.user_id — the ONE with real consequences.
--      Every board load filters on both, so each is a sequential scan. At
--      ~1,000 nodes (Nov 2026) that is invisible, but it degrades as the
--      tables grow: the creation walk now writes a node per build, and the
--      planned Supabase inventory table adds more query load. Not urgent;
--      add both when load times start to show it, or alongside the inventory
--      table work:
--        create index on exploration_nodes (whiteboard_id);
--        create index on exploration_whiteboards (user_id);
--
--   2. idx_ingredient_affinities_name duplicates the unique index
--      ingredient_affinities_ingredient_name_key. Cosmetic: a little extra
--      write cost, no wrong behaviour. Likely an artifact of the RLS
--      retrofit after the Supabase security email. Left as is.
--
--   3. ingredient_affinities has two overlapping SELECT policies ("Allow
--      public read access" to public, and "anon read ingredient_affinities"
--      to anon, authenticated), both using (true). Permissive policies OR
--      together, so the pair grants nothing the first doesn't alone.
--      Cosmetic, same likely origin as (2). Left as is.
--
-- -----------------------------------------------------------------------------
-- ACCESS: RLS AND GRANTS (all eight tables)
-- -----------------------------------------------------------------------------
--
--   RLS is ENABLED on all eight tables (not forced; the table owner and
--   service_role bypass it, as the service-role key does).
--
--   Grants: anon, authenticated and service_role each hold ALL table
--   privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
--   TRIGGER) on all eight — the automatic grants these tables got before the
--   30 Oct 2026 change. Access control is therefore entirely RLS: a policy
--   is the only thing standing between anon and a table. TRUNCATE is not
--   subject to RLS, but PostgREST exposes no TRUNCATE, so it is unreachable
--   through the app's keys.
--
--   Policy roles: policies listed "to public" apply to every role, anon
--   included; for anon auth.uid() is null, so the per-user policies match
--   no rows. The shared tables (inventory_tags, ingredient_affinities) are
--   readable by anyone and writable — insert, update AND delete, any row —
--   by any signed-in user.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- exploration_whiteboards — one board per exploration or creation
-- -----------------------------------------------------------------------------
create table exploration_whiteboards (
  id              uuid                     not null default gen_random_uuid(),
  user_id         uuid,
  title           text                     not null,
  status          text                     not null default 'active'::text,
  last_touched_at timestamp with time zone not null default now(),
  created_at      timestamp with time zone not null default now(),

  constraint exploration_whiteboards_pkey primary key (id),
  constraint exploration_whiteboards_status_check
    check ((status = any (array['active'::text, 'archived'::text]))),
  constraint exploration_whiteboards_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade
);
-- indexes: exploration_whiteboards_pkey (unique btree on id) only
-- policy "Users can manage their own whiteboards"  ALL  to public
--   using (auth.uid() = user_id)


-- -----------------------------------------------------------------------------
-- exploration_nodes — the nodes on a whiteboard
-- -----------------------------------------------------------------------------
create table exploration_nodes (
  id             uuid                     not null default gen_random_uuid(),
  whiteboard_id  uuid,
  parent_node_id uuid,
  node_type      text                     not null,
  payload        jsonb                    not null default '{}'::jsonb,
  notes          text,
  created_at     timestamp with time zone not null default now(),
  tried          boolean                           default false,
  tried_at       timestamp with time zone,

  constraint exploration_nodes_pkey primary key (id),
  -- !! A new node_type must be added here before the app can write it.
  constraint exploration_nodes_node_type_check
    check ((node_type = any (array['ingredients'::text, 'recipe_list'::text,
                                   'recipe'::text, 'tweak'::text, 'creation'::text]))),
  constraint exploration_nodes_parent_node_id_fkey
    foreign key (parent_node_id) references exploration_nodes(id) on delete set null,
  constraint exploration_nodes_whiteboard_id_fkey
    foreign key (whiteboard_id) references exploration_whiteboards(id) on delete cascade
);
-- indexes: exploration_nodes_pkey (unique btree on id) only
-- policy "Users can manage nodes on their own whiteboards"  ALL  to public
--   using (whiteboard_id in (select exploration_whiteboards.id
--                              from exploration_whiteboards
--                             where exploration_whiteboards.user_id = auth.uid()))


-- -----------------------------------------------------------------------------
-- to_make — On Deck
-- -----------------------------------------------------------------------------
create table to_make (
  id                        uuid                     not null default gen_random_uuid(),
  user_id                   uuid                     not null,
  recipe_name               text                     not null,
  summary                   text,
  recipe                    jsonb                             default '[]'::jsonb,
  ingredients               jsonb                             default '[]'::jsonb,
  variations                jsonb                             default '[]'::jsonb,
  notes                     text,
  mode                      text,
  saved_at                  timestamp with time zone          default now(),
  instructions              text,
  glass_type                text,
  source                    text                              default 'manual'::text,
  origin_flag               text,
  status                    text                              default 'ondeck'::text,
  primary_ingredients       jsonb                             default '[]'::jsonb,
  difficulty                text,
  origin                    text,
  creator                   text,
  bar                       text,
  year                      text,
  attribution_source        text,
  attribution_user_supplied boolean                           default false,
  parent_recipe             text,
  replacements              jsonb                             default '[]'::jsonb,
  name_user_supplied        boolean                           default false,

  constraint to_make_pkey primary key (id),
  constraint to_make_user_id_fkey foreign key (user_id) references auth.users(id),
  -- !! One row per recipe name per user (Session 18).
  constraint to_make_user_id_recipe_name_key unique (user_id, recipe_name)
);
-- indexes: to_make_pkey (unique btree on id),
--          to_make_user_id_recipe_name_key (unique btree on user_id, recipe_name)
-- policy "Users own their to make list"  ALL  to public
--   using (auth.uid() = user_id)


-- -----------------------------------------------------------------------------
-- favorites — Saved; same shape as to_make, status defaults to 'favorite'
-- -----------------------------------------------------------------------------
create table favorites (
  id                        uuid                     not null default gen_random_uuid(),
  user_id                   uuid                     not null,
  recipe_name               text                     not null,
  summary                   text,
  recipe                    jsonb                             default '[]'::jsonb,
  ingredients               jsonb                             default '[]'::jsonb,
  variations                jsonb                             default '[]'::jsonb,
  notes                     text,
  mode                      text,
  saved_at                  timestamp with time zone          default now(),
  instructions              text,
  glass_type                text,
  source                    text                              default 'manual'::text,
  origin_flag               text,
  status                    text                              default 'favorite'::text,
  primary_ingredients       jsonb                             default '[]'::jsonb,
  difficulty                text,
  origin                    text,
  creator                   text,
  bar                       text,
  year                      text,
  attribution_source        text,
  attribution_user_supplied boolean                           default false,
  parent_recipe             text,
  replacements              jsonb                             default '[]'::jsonb,
  name_user_supplied        boolean                           default false,

  constraint favorites_pkey primary key (id),
  constraint favorites_user_id_fkey foreign key (user_id) references auth.users(id),
  -- !! One row per recipe name per user (Session 18).
  constraint favorites_user_id_recipe_name_key unique (user_id, recipe_name)
);
-- indexes: favorites_pkey (unique btree on id),
--          favorites_user_id_recipe_name_key (unique btree on user_id, recipe_name)
-- policy "Users own their favorites"  ALL  to public
--   using (auth.uid() = user_id)


-- -----------------------------------------------------------------------------
-- inventory_tags — one row per bottle name: generic_type + aliases
-- (shared across users; append-only in practice)
-- -----------------------------------------------------------------------------
create table inventory_tags (
  item_name    text                     not null,
  generic_type text                     not null,
  aliases      jsonb                    not null default '[]'::jsonb,
  tagged_at    timestamp with time zone          default now(),

  constraint inventory_tags_pkey primary key (item_name)
);
-- indexes: inventory_tags_pkey (unique btree on item_name) only
-- policy "anon read inventory_tags"            SELECT  to anon, authenticated  using (true)
-- policy "authenticated write inventory_tags"  ALL     to authenticated        using (true) with check (true)


-- -----------------------------------------------------------------------------
-- ingredient_affinities — base affinity layer, one row per ingredient
-- (shared across users)
-- -----------------------------------------------------------------------------
create table ingredient_affinities (
  id                uuid                     not null default gen_random_uuid(),
  ingredient_name   text                     not null,
  category          text,
  flavor_affinities text                     not null,
  affinity_tags     text[]                   not null default '{}'::text[],
  analyzed_at       timestamp with time zone not null default now(),
  spirit_tags       text[]                   not null default '{}'::text[],
  flavor_tags       text[]                   not null default '{}'::text[],

  constraint ingredient_affinities_pkey primary key (id),
  constraint ingredient_affinities_ingredient_name_key unique (ingredient_name)
);
-- indexes: ingredient_affinities_pkey (unique btree on id),
--          ingredient_affinities_ingredient_name_key (unique btree on ingredient_name),
--          idx_ingredient_affinities_name (btree on ingredient_name — duplicates
--            the unique index above)
-- policy "Allow public read access"                   SELECT  to public               using (true)
-- policy "anon read ingredient_affinities"            SELECT  to anon, authenticated  using (true)
-- policy "authenticated write ingredient_affinities"  ALL     to authenticated        using (true) with check (true)
-- (the two SELECT policies overlap)
-- the three *_tags columns are reported by information_schema as ARRAY;
-- text[] per their '{}'::text[] defaults.


-- -----------------------------------------------------------------------------
-- explorations_history — cached Explore results per search
-- -----------------------------------------------------------------------------
create table explorations_history (
  id                  uuid                     not null default gen_random_uuid(),
  user_id             uuid                     not null,
  search_key          text                     not null,
  primary_ingredients text[]                   not null default '{}'::text[],
  low_abv             boolean                  not null default false,
  result              jsonb                    not null,
  updated_at          timestamp with time zone          default now(),
  template            text,
  frozen              boolean                           default false,
  na                  boolean                           default false,

  constraint explorations_history_pkey primary key (id),
  constraint explorations_history_user_id_fkey foreign key (user_id) references auth.users(id),
  -- the app upserts onConflict 'user_id,search_key' — depends on this
  constraint explorations_history_user_id_search_key_key unique (user_id, search_key)
);
-- indexes: explorations_history_pkey (unique btree on id),
--          explorations_history_user_id_search_key_key (unique btree on user_id, search_key)
-- policy "Users own their explorations history"  ALL  to public
--   using (auth.uid() = user_id)


-- -----------------------------------------------------------------------------
-- shopping_list
-- -----------------------------------------------------------------------------
create table shopping_list (
  id         uuid                     not null default gen_random_uuid(),
  user_id    uuid                     not null,
  name       text                     not null,
  created_at timestamp with time zone          default now(),

  constraint shopping_list_pkey primary key (id),
  constraint shopping_list_user_id_fkey foreign key (user_id) references auth.users(id),
  -- the app upserts onConflict 'user_id,name' — depends on this
  constraint shopping_list_user_id_name_key unique (user_id, name)
);
-- indexes: shopping_list_pkey (unique btree on id),
--          shopping_list_user_id_name_key (unique btree on user_id, name)
-- policy "Users own their shopping list"  ALL  to public
--   using (auth.uid() = user_id)
