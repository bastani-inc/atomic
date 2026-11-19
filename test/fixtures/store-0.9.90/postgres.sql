--
-- PostgreSQL database dump
--

\restrict zOUXBgiT81uKMPCjcuczfgcIp56tQlU4AXMiBlFSgmxdzhwWzbBA5G83fEtw69l

-- Dumped from database version 16.16 (Debian 16.16-1.pgdg13+1)
-- Dumped by pg_dump version 16.16 (Debian 16.16-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: atomic; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA atomic;


--
-- Name: session_entries_search_forget_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.session_entries_search_forget_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN IF (EXISTS (SELECT 1 FROM session_search_state WHERE session_id = OLD.session_id)) THEN DELETE FROM session_search_entries WHERE sid IN (SELECT sid FROM session_search_state WHERE session_id = OLD.session_id); DELETE FROM session_search_state WHERE session_id = OLD.session_id; END IF; RETURN NULL; END $$;


--
-- Name: session_entries_snapshot_links_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.session_entries_snapshot_links_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF ((SELECT backfilled_through >= watermark FROM snapshot_index_sources WHERE source = 'session-entries')) THEN /* session-entries@own-progress */ UPDATE snapshot_session_links SET children = children + 1 FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r WHERE snapshot_session_links.session_id = r.session_id AND snapshot_session_links.entry_id = r.parent_id AND r.parent_type = 'text' AND NOT EXISTS (SELECT 1 FROM snapshot_session_links AS own WHERE own.session_id = r.session_id AND own.seq = r.seq); INSERT INTO snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) SELECT r.session_id, r.seq, r.entry_id, CASE WHEN r.parent_type = 'text' THEN r.parent_id END, CASE WHEN strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' THEN r.seq ELSE parent.anchor_seq END, 0, CASE WHEN EXISTS (SELECT 1 FROM snapshot_session_links AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND other.seq <> r.seq) THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 WHEN r.parent_type = 'text' AND parent.entry_id IS NOT NULL THEN parent.broken ELSE 1 END FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r LEFT JOIN snapshot_session_links AS parent ON parent.session_id = r.session_id AND parent.entry_id = r.parent_id AND r.parent_type = 'text' ON CONFLICT DO NOTHING; END IF; RETURN NULL; END $_$;


--
-- Name: session_entries_snapshot_pending_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.session_entries_snapshot_pending_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN IF (NOT COALESCE((SELECT backfilled_through >= watermark FROM snapshot_index_sources WHERE source = 'session-entries'), true)) THEN /* session-entries@own-progress */ UPDATE snapshot_index_sources SET watermark = NEW.row_order WHERE source = 'session-entries' AND watermark < NEW.row_order; UPDATE snapshot_index_sources SET backfilled_through = NEW.row_order - 1 WHERE source = 'session-entries' AND backfilled_through >= NEW.row_order; UPDATE snapshot_index_sources SET watermark = NEW.row_order WHERE source = 'session-entries@own-progress' AND watermark < NEW.row_order; UPDATE snapshot_index_sources SET backfilled_through = NEW.row_order - 1 WHERE source = 'session-entries@own-progress' AND backfilled_through >= NEW.row_order; END IF; RETURN NULL; END $$;


--
-- Name: session_entries_snapshot_refs_delete_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.session_entries_snapshot_refs_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN /* session-entries@own-progress */ UPDATE snapshot_session_links SET children = children - 1 WHERE session_id = OLD.session_id AND children > 0 AND entry_id = (SELECT parent_id FROM snapshot_session_links WHERE session_id = OLD.session_id AND seq = OLD.seq); DELETE FROM snapshot_session_links WHERE session_id = OLD.session_id AND seq = OLD.seq; DELETE FROM snapshot_session_refs WHERE session_id = OLD.session_id AND seq = OLD.seq; DELETE FROM snapshot_session_records WHERE session_id = OLD.session_id AND seq = OLD.seq; RETURN NULL; END $$;


--
-- Name: session_entries_snapshot_refs_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.session_entries_snapshot_refs_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF (strpos(NEW.entry_json, '"worktree_snapshot"') > 0 AND (SELECT backfilled_through >= watermark FROM snapshot_index_sources WHERE source = 'session-entries')) THEN /* session-entries@own-progress */ INSERT INTO snapshot_session_refs (session_id, seq, root, snapshot_id, prev_seq, restore_from, restore_to, degraded_from, degraded_since) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'root'), ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), parent.anchor_seq, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,from}') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,to}') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{restore,from}') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,from}') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,to}') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{restore,to}') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'degradedFrom') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'degradedFrom') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'degradedFrom') = 'string' THEN COALESCE((SELECT earlier.degraded_since FROM snapshot_session_refs AS earlier WHERE earlier.session_id = r.session_id AND earlier.seq = parent.anchor_seq AND earlier.degraded_from = ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'degradedFrom')), (floor(extract(epoch from clock_timestamp())))::bigint) END FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r LEFT JOIN snapshot_session_links AS parent ON parent.session_id = r.session_id AND parent.entry_id = r.parent_id AND r.parent_type = 'text' WHERE strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT (session_id, seq) DO UPDATE SET root = excluded.root, snapshot_id = excluded.snapshot_id, prev_seq = excluded.prev_seq, restore_from = excluded.restore_from, restore_to = excluded.restore_to, degraded_from = excluded.degraded_from, degraded_since = excluded.degraded_since; INSERT INTO snapshot_session_records (session_id, seq, snapshot_id, hash) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), (link.value ->> 'patch') FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r, jsonb_path_query((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb, '$."snapshot"."chain"[*]') AS link(value) WHERE jsonb_typeof(link.value -> 'patch') = 'string' AND strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT DO NOTHING; INSERT INTO snapshot_session_records (session_id, seq, snapshot_id, hash) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{snapshot,bundle,blob}') FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r WHERE jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{snapshot,bundle,blob}') = 'string' AND strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT DO NOTHING; END IF; RETURN NULL; END $_$;


--
-- Name: snapshot_blobs_chunks_delete_all_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.snapshot_blobs_chunks_delete_all_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM snapshot_blob_chunks WHERE hash = OLD.hash; RETURN NULL; END $$;


--
-- Name: wf_events_snapshot_refs_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_events_snapshot_refs_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF (NEW.type = 'CheckpointRecorded' AND strpos(NEW.payload, '"worktreeSnapshots"') > 0 AND CASE WHEN ((NEW.payload) IS JSON) THEN (((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'kind') IN ('tool', 'stage')) ELSE false END) THEN INSERT INTO snapshot_run_refs (run_id, hash) SELECT r.run_id, (link.value ->> 'patch') FROM (SELECT NEW.run_id AS run_id, NEW.seq AS seq, NEW.payload AS payload) AS r, jsonb_path_query((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb, '$."worktreeSnapshots"[*]') AS snapshot(value), jsonb_path_query(snapshot.value, '$."chain"[*]') AS link(value) WHERE jsonb_typeof(link.value -> 'patch') = 'string' ON CONFLICT DO NOTHING; INSERT INTO snapshot_run_refs (run_id, hash) SELECT r.run_id, (snapshot.value #>> '{bundle,blob}') FROM (SELECT NEW.run_id AS run_id, NEW.seq AS seq, NEW.payload AS payload) AS r, jsonb_path_query((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb, '$."worktreeSnapshots"[*]') AS snapshot(value) WHERE jsonb_typeof(snapshot.value #> '{bundle,blob}') = 'string' ON CONFLICT DO NOTHING; END IF; RETURN NULL; END $_$;


--
-- Name: wf_events_snapshot_state_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_events_snapshot_state_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF (NEW.type IN ('RunStarted', 'StatusChanged') AND CASE WHEN ((NEW.payload) IS JSON) THEN (jsonb_typeof((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'workflowId') = 'string' AND jsonb_typeof((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'status') = 'string' AND (CASE jsonb_typeof(((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'completedCheckpoints')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'completedCheckpoints'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'completedCheckpoints'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'completedCheckpoints')) END) IN ('integer', 'real') AND (CASE jsonb_typeof(((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'pendingPrompts')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'pendingPrompts'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'pendingPrompts'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.payload, '\u') = 0 OR pg_input_is_valid(NEW.payload, 'jsonb') THEN NEW.payload ELSE regexp_replace(NEW.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'pendingPrompts')) END) IN ('integer', 'real')) ELSE false END) THEN INSERT INTO snapshot_run_state (run_id, retained, seq) SELECT r.run_id, CASE
		WHEN (CASE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId')) END) IS NOT NULL AND ((CASE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'rootWorkflowId')) END) <> 'text' OR ((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'rootWorkflowId') <> ((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'workflowId')) THEN 0
		WHEN ((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'status') IN ('failed', 'blocked', 'running', 'paused') THEN ((CASE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'resumable')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'resumable'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'resumable'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(r.payload, '\u') = 0 OR pg_input_is_valid(r.payload, 'jsonb') THEN r.payload ELSE regexp_replace(r.payload, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'resumable')) END) IS DISTINCT FROM 'false')::int
		ELSE 0
	END, r.seq FROM (SELECT NEW.run_id AS run_id, NEW.seq AS seq, NEW.payload AS payload) AS r WHERE true ON CONFLICT (run_id) DO UPDATE SET retained = excluded.retained, seq = excluded.seq WHERE excluded.seq >= snapshot_run_state.seq; END IF; RETURN NULL; END $_$;


--
-- Name: wf_ps_session_entries_search_forget_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_session_entries_search_forget_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN IF (EXISTS (SELECT 1 FROM wf_ps_session_search_state WHERE session_id = OLD.session_id)) THEN DELETE FROM wf_ps_session_search_entries WHERE sid IN (SELECT sid FROM wf_ps_session_search_state WHERE session_id = OLD.session_id); DELETE FROM wf_ps_session_search_state WHERE session_id = OLD.session_id; END IF; RETURN NULL; END $$;


--
-- Name: wf_ps_session_entries_snapshot_links_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_session_entries_snapshot_links_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF ((SELECT backfilled_through >= watermark FROM wf_ps_snapshot_index_sources WHERE source = 'session-entries')) THEN /* session-entries@own-progress */ UPDATE wf_ps_snapshot_session_links SET children = children + 1 FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r WHERE wf_ps_snapshot_session_links.session_id = r.session_id AND wf_ps_snapshot_session_links.entry_id = r.parent_id AND r.parent_type = 'text' AND NOT EXISTS (SELECT 1 FROM wf_ps_snapshot_session_links AS own WHERE own.session_id = r.session_id AND own.seq = r.seq); INSERT INTO wf_ps_snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) SELECT r.session_id, r.seq, r.entry_id, CASE WHEN r.parent_type = 'text' THEN r.parent_id END, CASE WHEN strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' THEN r.seq ELSE parent.anchor_seq END, 0, CASE WHEN EXISTS (SELECT 1 FROM wf_ps_snapshot_session_links AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND other.seq <> r.seq) THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 WHEN r.parent_type = 'text' AND parent.entry_id IS NOT NULL THEN parent.broken ELSE 1 END FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r LEFT JOIN wf_ps_snapshot_session_links AS parent ON parent.session_id = r.session_id AND parent.entry_id = r.parent_id AND r.parent_type = 'text' ON CONFLICT DO NOTHING; END IF; RETURN NULL; END $_$;


--
-- Name: wf_ps_session_entries_snapshot_pending_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_session_entries_snapshot_pending_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN IF (NOT COALESCE((SELECT backfilled_through >= watermark FROM wf_ps_snapshot_index_sources WHERE source = 'session-entries'), true)) THEN /* session-entries@own-progress */ UPDATE wf_ps_snapshot_index_sources SET watermark = NEW.row_order WHERE source = 'session-entries' AND watermark < NEW.row_order; UPDATE wf_ps_snapshot_index_sources SET backfilled_through = NEW.row_order - 1 WHERE source = 'session-entries' AND backfilled_through >= NEW.row_order; UPDATE wf_ps_snapshot_index_sources SET watermark = NEW.row_order WHERE source = 'session-entries@own-progress' AND watermark < NEW.row_order; UPDATE wf_ps_snapshot_index_sources SET backfilled_through = NEW.row_order - 1 WHERE source = 'session-entries@own-progress' AND backfilled_through >= NEW.row_order; END IF; RETURN NULL; END $$;


--
-- Name: wf_ps_session_entries_snapshot_refs_delete_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_session_entries_snapshot_refs_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN /* session-entries@own-progress */ UPDATE wf_ps_snapshot_session_links SET children = children - 1 WHERE session_id = OLD.session_id AND children > 0 AND entry_id = (SELECT parent_id FROM wf_ps_snapshot_session_links WHERE session_id = OLD.session_id AND seq = OLD.seq); DELETE FROM wf_ps_snapshot_session_links WHERE session_id = OLD.session_id AND seq = OLD.seq; DELETE FROM wf_ps_snapshot_session_refs WHERE session_id = OLD.session_id AND seq = OLD.seq; DELETE FROM wf_ps_snapshot_session_records WHERE session_id = OLD.session_id AND seq = OLD.seq; RETURN NULL; END $$;


--
-- Name: wf_ps_session_entries_snapshot_refs_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_session_entries_snapshot_refs_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$ BEGIN IF (strpos(NEW.entry_json, '"worktree_snapshot"') > 0 AND (SELECT backfilled_through >= watermark FROM wf_ps_snapshot_index_sources WHERE source = 'session-entries')) THEN /* session-entries@own-progress */ INSERT INTO wf_ps_snapshot_session_refs (session_id, seq, root, snapshot_id, prev_seq, restore_from, restore_to, degraded_from, degraded_since) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'root'), ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), parent.anchor_seq, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,from}') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,to}') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{restore,from}') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,from}') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{restore,to}') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{restore,to}') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'degradedFrom') = 'string' THEN ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'degradedFrom') END, CASE WHEN jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'degradedFrom') = 'string' THEN COALESCE((SELECT earlier.degraded_since FROM wf_ps_snapshot_session_refs AS earlier WHERE earlier.session_id = r.session_id AND earlier.seq = parent.anchor_seq AND earlier.degraded_from = ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'degradedFrom')), (floor(extract(epoch from clock_timestamp())))::bigint) END FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r LEFT JOIN wf_ps_snapshot_session_links AS parent ON parent.session_id = r.session_id AND parent.entry_id = r.parent_id AND r.parent_type = 'text' WHERE strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT (session_id, seq) DO UPDATE SET root = excluded.root, snapshot_id = excluded.snapshot_id, prev_seq = excluded.prev_seq, restore_from = excluded.restore_from, restore_to = excluded.restore_to, degraded_from = excluded.degraded_from, degraded_since = excluded.degraded_since; INSERT INTO wf_ps_snapshot_session_records (session_id, seq, snapshot_id, hash) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), (link.value ->> 'patch') FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r, jsonb_path_query((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb, '$."snapshot"."chain"[*]') AS link(value) WHERE jsonb_typeof(link.value -> 'patch') = 'string' AND strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT DO NOTHING; INSERT INTO wf_ps_snapshot_session_records (session_id, seq, snapshot_id, hash) SELECT r.session_id, r.seq, ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'snapshotId'), ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #>> '{snapshot,bundle,blob}') FROM (SELECT NEW.session_id AS session_id, NEW.seq AS seq, NEW.entry_id AS entry_id, NEW.entry_json AS entry_json, ((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'parentId') AS parent_id, (CASE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text WHEN 'number' THEN CASE WHEN (((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(((CASE WHEN strpos(NEW.entry_json, '\u') = 0 OR pg_input_is_valid(NEW.entry_json, 'jsonb') THEN NEW.entry_json ELSE regexp_replace(NEW.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'parentId')) END) AS parent_type) AS r WHERE jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb #> '{snapshot,bundle,blob}') = 'string' AND strpos(r.entry_json, '"worktree_snapshot"') > 0 AND ((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb ->> 'type') = 'worktree_snapshot' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'root') = 'string' AND jsonb_typeof((CASE WHEN strpos(r.entry_json, '\u') = 0 OR pg_input_is_valid(r.entry_json, 'jsonb') THEN r.entry_json ELSE regexp_replace(r.entry_json, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})', '\1\\ufffd', 'g') END)::jsonb -> 'snapshotId') = 'string' ON CONFLICT DO NOTHING; END IF; RETURN NULL; END $_$;


--
-- Name: wf_ps_snapshot_blobs_chunks_delete_all_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_ps_snapshot_blobs_chunks_delete_all_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM wf_ps_snapshot_blob_chunks WHERE hash = OLD.hash; RETURN NULL; END $$;


--
-- Name: wf_runs_pool_fence_abort_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_pool_fence_abort_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'atomic-pool-fence'; RETURN NEW; END $$;


--
-- Name: wf_runs_pool_usage_totals_delete_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_pool_usage_totals_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM wf_runs_pool_usage_totals WHERE root = (SELECT root FROM wf_runs_work WHERE id = OLD.work); RETURN NULL; END $$;


--
-- Name: wf_runs_pool_usage_totals_insert_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_pool_usage_totals_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN UPDATE wf_runs_pool_usage_totals SET input = input + (NEW.input), input_err = input_err + CASE WHEN abs(input) > abs((NEW.input)) THEN (input - (input + (NEW.input))) + (NEW.input) ELSE ((NEW.input) - (input + (NEW.input))) + input END, output = output + (NEW.output), output_err = output_err + CASE WHEN abs(output) > abs((NEW.output)) THEN (output - (output + (NEW.output))) + (NEW.output) ELSE ((NEW.output) - (output + (NEW.output))) + output END, cacheread = cacheread + (NEW.cacheread), cacheread_err = cacheread_err + CASE WHEN abs(cacheread) > abs((NEW.cacheread)) THEN (cacheread - (cacheread + (NEW.cacheread))) + (NEW.cacheread) ELSE ((NEW.cacheread) - (cacheread + (NEW.cacheread))) + cacheread END, cachewrite = cachewrite + (NEW.cachewrite), cachewrite_err = cachewrite_err + CASE WHEN abs(cachewrite) > abs((NEW.cachewrite)) THEN (cachewrite - (cachewrite + (NEW.cachewrite))) + (NEW.cachewrite) ELSE ((NEW.cachewrite) - (cachewrite + (NEW.cachewrite))) + cachewrite END, cost = cost + (NEW.cost), cost_err = cost_err + CASE WHEN abs(cost) > abs((NEW.cost)) THEN (cost - (cost + (NEW.cost))) + (NEW.cost) ELSE ((NEW.cost) - (cost + (NEW.cost))) + cost END WHERE root = (SELECT root FROM wf_runs_work WHERE id = NEW.work); RETURN NULL; END $$;


--
-- Name: wf_runs_pool_usage_totals_update_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_pool_usage_totals_update_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN IF (OLD.input IS DISTINCT FROM NEW.input OR OLD.output IS DISTINCT FROM NEW.output OR OLD.cacheread IS DISTINCT FROM NEW.cacheread OR OLD.cachewrite IS DISTINCT FROM NEW.cachewrite OR OLD.cost IS DISTINCT FROM NEW.cost OR OLD.work IS DISTINCT FROM NEW.work) THEN UPDATE wf_runs_pool_usage_totals SET input = input + (-OLD.input), input_err = input_err + CASE WHEN abs(input) > abs((-OLD.input)) THEN (input - (input + (-OLD.input))) + (-OLD.input) ELSE ((-OLD.input) - (input + (-OLD.input))) + input END, output = output + (-OLD.output), output_err = output_err + CASE WHEN abs(output) > abs((-OLD.output)) THEN (output - (output + (-OLD.output))) + (-OLD.output) ELSE ((-OLD.output) - (output + (-OLD.output))) + output END, cacheread = cacheread + (-OLD.cacheread), cacheread_err = cacheread_err + CASE WHEN abs(cacheread) > abs((-OLD.cacheread)) THEN (cacheread - (cacheread + (-OLD.cacheread))) + (-OLD.cacheread) ELSE ((-OLD.cacheread) - (cacheread + (-OLD.cacheread))) + cacheread END, cachewrite = cachewrite + (-OLD.cachewrite), cachewrite_err = cachewrite_err + CASE WHEN abs(cachewrite) > abs((-OLD.cachewrite)) THEN (cachewrite - (cachewrite + (-OLD.cachewrite))) + (-OLD.cachewrite) ELSE ((-OLD.cachewrite) - (cachewrite + (-OLD.cachewrite))) + cachewrite END, cost = cost + (-OLD.cost), cost_err = cost_err + CASE WHEN abs(cost) > abs((-OLD.cost)) THEN (cost - (cost + (-OLD.cost))) + (-OLD.cost) ELSE ((-OLD.cost) - (cost + (-OLD.cost))) + cost END WHERE root = (SELECT root FROM wf_runs_work WHERE id = OLD.work); UPDATE wf_runs_pool_usage_totals SET input = input + (NEW.input), input_err = input_err + CASE WHEN abs(input) > abs((NEW.input)) THEN (input - (input + (NEW.input))) + (NEW.input) ELSE ((NEW.input) - (input + (NEW.input))) + input END, output = output + (NEW.output), output_err = output_err + CASE WHEN abs(output) > abs((NEW.output)) THEN (output - (output + (NEW.output))) + (NEW.output) ELSE ((NEW.output) - (output + (NEW.output))) + output END, cacheread = cacheread + (NEW.cacheread), cacheread_err = cacheread_err + CASE WHEN abs(cacheread) > abs((NEW.cacheread)) THEN (cacheread - (cacheread + (NEW.cacheread))) + (NEW.cacheread) ELSE ((NEW.cacheread) - (cacheread + (NEW.cacheread))) + cacheread END, cachewrite = cachewrite + (NEW.cachewrite), cachewrite_err = cachewrite_err + CASE WHEN abs(cachewrite) > abs((NEW.cachewrite)) THEN (cachewrite - (cachewrite + (NEW.cachewrite))) + (NEW.cachewrite) ELSE ((NEW.cachewrite) - (cachewrite + (NEW.cachewrite))) + cachewrite END, cost = cost + (NEW.cost), cost_err = cost_err + CASE WHEN abs(cost) > abs((NEW.cost)) THEN (cost - (cost + (NEW.cost))) + (NEW.cost) ELSE ((NEW.cost) - (cost + (NEW.cost))) + cost END WHERE root = (SELECT root FROM wf_runs_work WHERE id = NEW.work); END IF; RETURN NULL; END $$;


--
-- Name: wf_runs_pool_usage_totals_work_delete_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_pool_usage_totals_work_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM wf_runs_pool_usage_totals WHERE root = OLD.root; RETURN OLD; END $$;


--
-- Name: wf_runs_snapshot_refs_delete_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_snapshot_refs_delete_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM snapshot_run_refs WHERE run_id = OLD.run_id; DELETE FROM snapshot_run_state WHERE run_id = OLD.run_id; RETURN NULL; END $$;


--
-- Name: wf_runs_snapshot_state_insert_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_snapshot_state_insert_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN INSERT INTO snapshot_run_state (run_id, retained, seq) SELECT r.run_id, (r.status NOT IN ('completed', 'cancelled'))::int, -1 FROM (SELECT NEW.run_id AS run_id, NEW.status AS status) AS r WHERE true ON CONFLICT (run_id) DO NOTHING; RETURN NULL; END $$;


--
-- Name: wf_runs_snapshot_state_status_fn(); Type: FUNCTION; Schema: atomic; Owner: -
--

CREATE FUNCTION atomic.wf_runs_snapshot_state_status_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN UPDATE snapshot_run_state SET retained = (NEW.status NOT IN ('completed', 'cancelled'))::int WHERE run_id = NEW.run_id AND seq = -1; RETURN NULL; END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: atomic_migrations; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.atomic_migrations (
    domain text NOT NULL,
    version bigint NOT NULL,
    applied_at bigint NOT NULL
);


--
-- Name: intercom_held_sends; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_held_sends (
    "order" bigint NOT NULL,
    message_id text NOT NULL,
    reservation_key text NOT NULL,
    origin_broker_id text NOT NULL,
    sender_session_id text NOT NULL,
    request_json text NOT NULL,
    held_at bigint NOT NULL
);


--
-- Name: intercom_held_sends_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_held_sends ALTER COLUMN "order" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_held_sends_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: intercom_known_sessions; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_known_sessions (
    record_order bigint NOT NULL,
    target_identity text NOT NULL,
    intercom_session_id text NOT NULL,
    name_json text,
    name_key text,
    atomic_session_id text,
    group_name text NOT NULL,
    groups_json text NOT NULL,
    recipient_purpose text,
    reply_capability text,
    recorded_at bigint NOT NULL,
    lost_at bigint
);


--
-- Name: intercom_known_sessions_record_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_known_sessions ALTER COLUMN record_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_known_sessions_record_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: intercom_leases; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_leases (
    kind text NOT NULL,
    key text NOT NULL,
    holder_id text,
    fencing_token bigint,
    last_token bigint NOT NULL,
    subject_json text,
    renewed_at bigint,
    first_acquired_order bigint NOT NULL
);


--
-- Name: intercom_outbox; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_outbox (
    sequence bigint NOT NULL,
    message_id text NOT NULL,
    target_identity text NOT NULL,
    origin_broker_id text NOT NULL,
    digest text NOT NULL,
    frame_json text NOT NULL,
    state text NOT NULL,
    claim_attempts bigint DEFAULT 0 NOT NULL,
    claimant_id text,
    claim_token text,
    claim_renewed_at bigint,
    failure_reason text,
    settled_at bigint,
    saving_at bigint,
    queued_at bigint,
    frame_bytes bigint,
    CONSTRAINT intercom_outbox_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'claimed'::text, 'delivered'::text, 'failed'::text])))
);


--
-- Name: intercom_outbox_sequence_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_outbox ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_outbox_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: intercom_pending_asks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_pending_asks (
    "order" bigint NOT NULL,
    sender_session_id text NOT NULL,
    target_session_id text NOT NULL,
    message_id text NOT NULL,
    park_owner text,
    park_key text,
    replied bigint,
    ended_at bigint
);


--
-- Name: intercom_pending_asks_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_pending_asks ALTER COLUMN "order" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_pending_asks_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: intercom_released_asks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_released_asks (
    "order" bigint NOT NULL,
    question_id text NOT NULL,
    replier_session_id text NOT NULL,
    asker_session_id text NOT NULL,
    child_name text NOT NULL,
    owner_session_id text NOT NULL,
    state text NOT NULL,
    reply_message_id text,
    claimed_at bigint,
    expires_at bigint NOT NULL,
    CONSTRAINT intercom_released_asks_state_check CHECK ((state = ANY (ARRAY['open'::text, 'claimed'::text, 'answered'::text])))
);


--
-- Name: intercom_released_asks_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_released_asks ALTER COLUMN "order" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_released_asks_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: intercom_restoring_reservation_counters; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_restoring_reservation_counters (
    name text NOT NULL,
    value bigint NOT NULL
);


--
-- Name: intercom_restoring_reservations; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_restoring_reservations (
    reservation_key text NOT NULL,
    "order" bigint NOT NULL,
    owner_session_id text NOT NULL,
    owner_broker_id text NOT NULL,
    child_name text NOT NULL,
    child_target text NOT NULL,
    targets_json text NOT NULL,
    "group" text NOT NULL,
    dormant bigint NOT NULL,
    fencing_token bigint NOT NULL,
    gone text,
    renewed_at bigint NOT NULL,
    end_json text,
    ended_at bigint,
    wake bigint DEFAULT 0 NOT NULL,
    wake_requested bigint DEFAULT 0 NOT NULL,
    wake_generation bigint DEFAULT 0 NOT NULL
);


--
-- Name: intercom_restoring_wake_claims; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_restoring_wake_claims (
    reservation_key text NOT NULL,
    fencing_token bigint NOT NULL,
    message_id text NOT NULL
);


--
-- Name: intercom_sent_messages; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_sent_messages (
    message_id text NOT NULL,
    digest text NOT NULL,
    target_identity text NOT NULL,
    question_route_json text,
    state text NOT NULL,
    recorded_at bigint NOT NULL,
    CONSTRAINT intercom_sent_messages_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'accepted'::text])))
);


--
-- Name: intercom_session_bindings; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_session_bindings (
    intercom_session_id text NOT NULL,
    return_address text NOT NULL,
    recorded_at bigint NOT NULL
);


--
-- Name: intercom_settled_asks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_settled_asks (
    sender_session_id text NOT NULL,
    target_session_id text NOT NULL,
    message_id text NOT NULL,
    settled_at bigint NOT NULL
);


--
-- Name: intercom_wakeups; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.intercom_wakeups (
    id bigint NOT NULL,
    broker_id text NOT NULL,
    reason text NOT NULL,
    version bigint NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT intercom_wakeups_reason_check CHECK ((reason = ANY (ARRAY['outbox'::text, 'outcome'::text])))
);


--
-- Name: intercom_wakeups_id_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.intercom_wakeups ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.intercom_wakeups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: session_blob_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_blob_chunks (
    session_id text NOT NULL,
    hash text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: session_blobs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_blobs (
    session_id text NOT NULL,
    hash text NOT NULL,
    bytes bigint NOT NULL,
    chunks bigint NOT NULL
);


--
-- Name: session_entries; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_entries (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    entry_id text NOT NULL,
    entry_json text NOT NULL,
    row_order bigint NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL,
    CONSTRAINT session_entries_entry_json_check CHECK ((entry_json IS JSON))
);


--
-- Name: session_entries_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.session_entries ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.session_entries_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: session_entry_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_entry_chunks (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: session_meta; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_meta (
    schema_version bigint NOT NULL
);


--
-- Name: session_open; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_open (
    session_id text NOT NULL,
    token text NOT NULL,
    pid bigint NOT NULL,
    host text NOT NULL,
    heartbeat_at bigint NOT NULL,
    schema_version bigint
);


--
-- Name: session_search_entries; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_search_entries (
    sid bigint NOT NULL,
    seq bigint NOT NULL,
    part bigint NOT NULL,
    body text NOT NULL
);


--
-- Name: session_search_state; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_search_state (
    sid bigint NOT NULL,
    session_id text NOT NULL,
    format bigint NOT NULL,
    indexed_seq bigint NOT NULL,
    revision text NOT NULL,
    entry_id text NOT NULL
);


--
-- Name: session_search_state_sid_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.session_search_state ALTER COLUMN sid ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.session_search_state_sid_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: session_search_texts; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_search_texts (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    text_json text NOT NULL,
    CONSTRAINT session_search_texts_text_json_check CHECK ((text_json IS JSON))
);


--
-- Name: session_sessions; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.session_sessions (
    id text NOT NULL,
    cwd text NOT NULL,
    created_at text NOT NULL,
    header_json text NOT NULL,
    internal bigint NOT NULL,
    last_seq bigint NOT NULL,
    modified_at text NOT NULL,
    message_count bigint NOT NULL,
    first_message text NOT NULL,
    name text,
    has_name bigint NOT NULL,
    summary text,
    summarized_through_id text,
    summary_state text NOT NULL,
    revision text DEFAULT ''::text NOT NULL,
    row_order bigint NOT NULL,
    CONSTRAINT session_sessions_first_message_check CHECK ((first_message IS JSON)),
    CONSTRAINT session_sessions_header_json_check CHECK ((header_json IS JSON)),
    CONSTRAINT session_sessions_name_check CHECK (((name IS NULL) OR (name IS JSON))),
    CONSTRAINT session_sessions_summary_check CHECK (((summary IS NULL) OR (summary IS JSON))),
    CONSTRAINT session_sessions_summary_state_check CHECK ((summary_state IS JSON))
);


--
-- Name: session_sessions_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.session_sessions ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.session_sessions_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: snapshot_blob_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_blob_chunks (
    hash text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: snapshot_blobs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_blobs (
    hash text NOT NULL,
    bytes bigint NOT NULL,
    data bytea NOT NULL,
    created_at bigint DEFAULT (floor(EXTRACT(epoch FROM clock_timestamp())))::bigint NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL
);


--
-- Name: snapshot_carried_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_carried_refs (
    owner text NOT NULL,
    hash text NOT NULL
);


--
-- Name: snapshot_collection; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_collection (
    id bigint NOT NULL,
    claimed_at bigint,
    holder text,
    finished_at bigint,
    deleted bigint,
    error_code text,
    CONSTRAINT snapshot_collection_id_check CHECK ((id = 1))
);


--
-- Name: snapshot_index_sources; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_index_sources (
    source text NOT NULL,
    watermark bigint NOT NULL,
    backfilled_through bigint NOT NULL
);


--
-- Name: snapshot_run_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_run_refs (
    run_id text NOT NULL,
    hash text NOT NULL
);


--
-- Name: snapshot_run_state; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_run_state (
    run_id text NOT NULL,
    retained bigint NOT NULL,
    seq bigint NOT NULL
);


--
-- Name: snapshot_session_links; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_session_links (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    entry_id text NOT NULL,
    parent_id text,
    anchor_seq bigint,
    children bigint NOT NULL,
    broken bigint NOT NULL
);


--
-- Name: snapshot_session_records; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_session_records (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    snapshot_id text NOT NULL,
    hash text NOT NULL
);


--
-- Name: snapshot_session_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.snapshot_session_refs (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    root text NOT NULL,
    snapshot_id text NOT NULL,
    prev_seq bigint,
    restore_from text,
    restore_to text,
    degraded_from text,
    degraded_since bigint
);


--
-- Name: wf_event_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_event_chunks (
    run_id text NOT NULL,
    seq bigint NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_events; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_events (
    run_id text NOT NULL,
    seq bigint NOT NULL,
    epoch bigint NOT NULL,
    key text COLLATE pg_catalog."C",
    type text NOT NULL,
    payload text NOT NULL,
    at bigint NOT NULL,
    row_order bigint NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_events_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_events ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_events_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_lease_builds; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_lease_builds (
    run_id text NOT NULL,
    holder_id text NOT NULL,
    epoch bigint NOT NULL,
    schema_version bigint NOT NULL
);


--
-- Name: wf_leases; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_leases (
    run_id text NOT NULL,
    holder_id text,
    epoch bigint NOT NULL,
    renewed_at bigint NOT NULL
);


--
-- Name: wf_meta; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_meta (
    schema_version bigint NOT NULL
);


--
-- Name: wf_ps_atomic_migrations; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_atomic_migrations (
    domain text NOT NULL,
    version bigint NOT NULL,
    applied_at bigint NOT NULL
);


--
-- Name: wf_ps_session_blob_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_blob_chunks (
    session_id text NOT NULL,
    hash text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_ps_session_blobs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_blobs (
    session_id text NOT NULL,
    hash text NOT NULL,
    bytes bigint NOT NULL,
    chunks bigint NOT NULL
);


--
-- Name: wf_ps_session_entries; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_entries (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    entry_id text NOT NULL,
    entry_json text NOT NULL,
    row_order bigint NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL,
    CONSTRAINT wf_ps_session_entries_entry_json_check CHECK ((entry_json IS JSON))
);


--
-- Name: wf_ps_session_entries_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_ps_session_entries ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_ps_session_entries_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_ps_session_entry_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_entry_chunks (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_ps_session_meta; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_meta (
    schema_version bigint NOT NULL
);


--
-- Name: wf_ps_session_open; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_open (
    session_id text NOT NULL,
    token text NOT NULL,
    pid bigint NOT NULL,
    host text NOT NULL,
    heartbeat_at bigint NOT NULL,
    schema_version bigint
);


--
-- Name: wf_ps_session_owners; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_owners (
    session text NOT NULL,
    work text NOT NULL,
    replay_key text NOT NULL
);


--
-- Name: wf_ps_session_search_entries; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_search_entries (
    sid bigint NOT NULL,
    seq bigint NOT NULL,
    part bigint NOT NULL,
    body text NOT NULL
);


--
-- Name: wf_ps_session_search_state; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_search_state (
    sid bigint NOT NULL,
    session_id text NOT NULL,
    format bigint NOT NULL,
    indexed_seq bigint NOT NULL,
    revision text NOT NULL,
    entry_id text NOT NULL
);


--
-- Name: wf_ps_session_search_state_sid_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_ps_session_search_state ALTER COLUMN sid ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_ps_session_search_state_sid_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_ps_session_search_texts; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_search_texts (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    text_json text NOT NULL,
    CONSTRAINT wf_ps_session_search_texts_text_json_check CHECK ((text_json IS JSON))
);


--
-- Name: wf_ps_session_sessions; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_session_sessions (
    id text NOT NULL,
    cwd text NOT NULL,
    created_at text NOT NULL,
    header_json text NOT NULL,
    internal bigint NOT NULL,
    last_seq bigint NOT NULL,
    modified_at text NOT NULL,
    message_count bigint NOT NULL,
    first_message text NOT NULL,
    name text,
    has_name bigint NOT NULL,
    summary text,
    summarized_through_id text,
    summary_state text NOT NULL,
    revision text DEFAULT ''::text NOT NULL,
    row_order bigint NOT NULL,
    CONSTRAINT wf_ps_session_sessions_first_message_check CHECK ((first_message IS JSON)),
    CONSTRAINT wf_ps_session_sessions_header_json_check CHECK ((header_json IS JSON)),
    CONSTRAINT wf_ps_session_sessions_name_check CHECK (((name IS NULL) OR (name IS JSON))),
    CONSTRAINT wf_ps_session_sessions_summary_check CHECK (((summary IS NULL) OR (summary IS JSON))),
    CONSTRAINT wf_ps_session_sessions_summary_state_check CHECK ((summary_state IS JSON))
);


--
-- Name: wf_ps_session_sessions_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_ps_session_sessions ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_ps_session_sessions_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_ps_snapshot_blob_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_blob_chunks (
    hash text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_ps_snapshot_blobs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_blobs (
    hash text NOT NULL,
    bytes bigint NOT NULL,
    data bytea NOT NULL,
    created_at bigint DEFAULT (floor(EXTRACT(epoch FROM clock_timestamp())))::bigint NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_ps_snapshot_carried_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_carried_refs (
    owner text NOT NULL,
    hash text NOT NULL
);


--
-- Name: wf_ps_snapshot_collection; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_collection (
    id bigint NOT NULL,
    claimed_at bigint,
    holder text,
    finished_at bigint,
    deleted bigint,
    error_code text,
    CONSTRAINT wf_ps_snapshot_collection_id_check CHECK ((id = 1))
);


--
-- Name: wf_ps_snapshot_index_sources; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_index_sources (
    source text NOT NULL,
    watermark bigint NOT NULL,
    backfilled_through bigint NOT NULL
);


--
-- Name: wf_ps_snapshot_run_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_run_refs (
    run_id text NOT NULL,
    hash text NOT NULL
);


--
-- Name: wf_ps_snapshot_run_state; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_run_state (
    run_id text NOT NULL,
    retained bigint NOT NULL,
    seq bigint NOT NULL
);


--
-- Name: wf_ps_snapshot_session_links; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_session_links (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    entry_id text NOT NULL,
    parent_id text,
    anchor_seq bigint,
    children bigint NOT NULL,
    broken bigint NOT NULL
);


--
-- Name: wf_ps_snapshot_session_records; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_session_records (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    snapshot_id text NOT NULL,
    hash text NOT NULL
);


--
-- Name: wf_ps_snapshot_session_refs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_ps_snapshot_session_refs (
    session_id text NOT NULL,
    seq bigint NOT NULL,
    root text NOT NULL,
    snapshot_id text NOT NULL,
    prev_seq bigint,
    restore_from text,
    restore_to text,
    degraded_from text,
    degraded_since bigint
);


--
-- Name: wf_runs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs (
    run_id text NOT NULL,
    name text NOT NULL,
    cwd text NOT NULL,
    created_at bigint NOT NULL,
    status text NOT NULL,
    header_json text NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_fleet_controller; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_fleet_controller (
    id bigint NOT NULL,
    holder text NOT NULL,
    epoch bigint NOT NULL,
    renewed_at bigint NOT NULL,
    lease_ms bigint NOT NULL,
    CONSTRAINT wf_runs_fleet_controller_id_check CHECK ((id = 1))
);


--
-- Name: wf_runs_fleet_drains; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_fleet_drains (
    host text NOT NULL,
    provider_id text,
    requested_at bigint NOT NULL
);


--
-- Name: wf_runs_fleet_events; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_fleet_events (
    seq bigint NOT NULL,
    at bigint NOT NULL,
    kind text NOT NULL,
    target bigint,
    live bigint,
    reason text NOT NULL,
    error text
);


--
-- Name: wf_runs_fleet_events_seq_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_fleet_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_fleet_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_pool; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool (
    root text NOT NULL,
    timeout bigint NOT NULL
);


--
-- Name: wf_runs_pool_activity; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_activity (
    work text NOT NULL,
    token text NOT NULL,
    runs text NOT NULL,
    version bigint NOT NULL
);


--
-- Name: wf_runs_pool_control; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_control (
    root text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_pool_fence; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_fence (
    reason text
);


--
-- Name: wf_runs_pool_hosts; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_hosts (
    host text NOT NULL,
    labels text NOT NULL,
    git text NOT NULL,
    restore bigint NOT NULL,
    workers bigint NOT NULL,
    max_workers bigint NOT NULL,
    heartbeat_at bigint NOT NULL,
    roots text DEFAULT '[]'::text NOT NULL,
    slots_busy bigint,
    draining bigint DEFAULT 0 NOT NULL,
    degraded text,
    provider_id text,
    journal_schema bigint,
    shipping text,
    progress text,
    status_at bigint
);


--
-- Name: wf_runs_pool_meta; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_meta (
    version bigint NOT NULL
);


--
-- Name: wf_runs_pool_operations; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_operations (
    work text NOT NULL,
    generation bigint NOT NULL,
    operation text NOT NULL,
    request text NOT NULL,
    receipt text NOT NULL
);


--
-- Name: wf_runs_pool_restore_backoffs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_restore_backoffs (
    host text NOT NULL,
    binding text NOT NULL,
    until bigint NOT NULL,
    failure text NOT NULL,
    recorded_at bigint NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_pool_restore_backoffs_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_pool_restore_backoffs ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_pool_restore_backoffs_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_pool_root_snapshot; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_root_snapshot (
    root text NOT NULL,
    epoch bigint NOT NULL,
    snapshot text NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_pool_root_snapshot_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_pool_root_snapshot ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_pool_root_snapshot_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_pool_shared; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_shared (
    root text NOT NULL,
    config text NOT NULL,
    epoch bigint NOT NULL,
    budget_blocked bigint DEFAULT 0 NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_pool_shared_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_pool_shared ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_pool_shared_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_pool_usage; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_usage (
    work text NOT NULL,
    generation bigint NOT NULL,
    key text NOT NULL,
    input double precision NOT NULL,
    output double precision NOT NULL,
    cacheread double precision NOT NULL,
    cachewrite double precision NOT NULL,
    cost double precision NOT NULL
);


--
-- Name: wf_runs_pool_usage_totals; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_pool_usage_totals (
    root text NOT NULL,
    input double precision NOT NULL,
    input_err double precision NOT NULL,
    output double precision NOT NULL,
    output_err double precision NOT NULL,
    cacheread double precision NOT NULL,
    cacheread_err double precision NOT NULL,
    cachewrite double precision NOT NULL,
    cachewrite_err double precision NOT NULL,
    cost double precision NOT NULL,
    cost_err double precision NOT NULL
);


--
-- Name: wf_runs_rate_buckets; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_rate_buckets (
    scope text NOT NULL,
    tat bigint NOT NULL,
    interval_ms double precision NOT NULL,
    burst bigint NOT NULL,
    cooldown_until bigint DEFAULT 0 NOT NULL,
    kind text,
    updated_at bigint,
    acquired double precision DEFAULT 0 NOT NULL,
    waiting_ms double precision DEFAULT 0 NOT NULL,
    waiting_gc_at bigint DEFAULT 0 NOT NULL,
    waiting_epoch bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_rate_waiting; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_rate_waiting (
    scope text NOT NULL,
    reporter text NOT NULL,
    total_ms double precision NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_resource_limits; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_resource_limits (
    scope text NOT NULL,
    config text NOT NULL
);


--
-- Name: wf_runs_resource_owners; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_resource_owners (
    id text NOT NULL,
    host text NOT NULL,
    pid bigint NOT NULL,
    expires_at bigint NOT NULL,
    boot text
);


--
-- Name: wf_runs_resource_permits; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_resource_permits (
    ticket bigint NOT NULL,
    operation text NOT NULL,
    root text NOT NULL,
    holder text NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    reason text,
    owner text,
    attempt text,
    process_identity text,
    root_epoch bigint,
    granted_at bigint
);


--
-- Name: wf_runs_resource_permits_ticket_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_resource_permits ALTER COLUMN ticket ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_resource_permits_ticket_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_ship_batches; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_ship_batches (
    batch text NOT NULL,
    work text NOT NULL,
    generation bigint NOT NULL,
    worker text,
    epoch bigint NOT NULL,
    host text NOT NULL,
    first_local_seq bigint NOT NULL,
    last_local_seq bigint NOT NULL,
    events bigint NOT NULL,
    shipped_at bigint NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_ship_batches_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_ship_batches ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_ship_batches_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_ship_watermarks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_ship_watermarks (
    work text NOT NULL,
    generation bigint NOT NULL,
    host text NOT NULL,
    last_local_seq bigint NOT NULL,
    last_event_key text NOT NULL,
    shipped_at bigint NOT NULL,
    row_order bigint NOT NULL
);


--
-- Name: wf_runs_ship_watermarks_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_ship_watermarks ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_ship_watermarks_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wf_runs_stage_inputs; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_stage_inputs (
    root text NOT NULL,
    run_id text NOT NULL,
    stage_id text NOT NULL,
    seq bigint NOT NULL,
    work text NOT NULL,
    kind text NOT NULL,
    op text NOT NULL,
    payload text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    receipt text,
    created_at bigint NOT NULL,
    settled_at bigint
);


--
-- Name: wf_runs_stage_leases; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_stage_leases (
    root text NOT NULL,
    run_id text NOT NULL,
    stage_id text NOT NULL,
    token bigint NOT NULL,
    work text,
    generation bigint,
    worker text,
    epoch bigint,
    seq bigint,
    expires_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_stage_workspaces; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_stage_workspaces (
    root text NOT NULL,
    run_id text NOT NULL,
    stage_id text NOT NULL,
    work text NOT NULL,
    generation bigint NOT NULL,
    host text NOT NULL,
    worktree text NOT NULL,
    binding text,
    recorded_at bigint NOT NULL
);


--
-- Name: wf_runs_work; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_work (
    id text NOT NULL,
    root text NOT NULL,
    boundary text NOT NULL,
    descriptor text NOT NULL,
    fingerprint text NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    worker text,
    epoch bigint DEFAULT 0 NOT NULL,
    expires_at bigint DEFAULT 0 NOT NULL,
    renewed_at bigint DEFAULT 0 NOT NULL,
    ready_at bigint NOT NULL,
    row_order bigint NOT NULL,
    inputs_chunks bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_work_input_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_work_input_chunks (
    work text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_runs_work_result_chunks; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_work_result_chunks (
    work text NOT NULL,
    idx bigint NOT NULL,
    data bytea NOT NULL
);


--
-- Name: wf_runs_work_results; Type: TABLE; Schema: atomic; Owner: -
--

CREATE TABLE atomic.wf_runs_work_results (
    work text NOT NULL,
    result text NOT NULL,
    chunks bigint DEFAULT 0 NOT NULL
);


--
-- Name: wf_runs_work_row_order_seq; Type: SEQUENCE; Schema: atomic; Owner: -
--

ALTER TABLE atomic.wf_runs_work ALTER COLUMN row_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME atomic.wf_runs_work_row_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Data for Name: atomic_migrations; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('sessions', 1, 1795109038815);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('sessions', 2, 1795109038819);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('session-presence', 1, 1795109038824);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('session-presence', 2, 1795109038826);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 1, 1795109038864);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 2, 1795109038869);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 3, 1795109038875);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 4, 1795109038876);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 5, 1795109038879);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('session-search', 1, 1795109038889);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-leases', 1, 1795109038895);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-outbox', 1, 1795109038899);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-outbox-indexes', 1, 1795109038908);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-held-sends', 1, 1795109038912);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-restoring-reservations', 1, 1795109038918);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-restoring-reservation-indexes', 1, 1795109038930);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-pending-asks', 1, 1795109038936);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-settled-asks', 1, 1795109038948);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-released-asks', 1, 1795109038954);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-sent-messages', 1, 1795109038957);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-known-sessions', 1, 1795109038964);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:intercom-wakeups', 1, 1795109038978);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:pool-queue', 1, 1795109039051);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:pool-ship', 1, 1795109039057);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:pool-usage', 1, 1795109039062);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:shared-pool', 2, 1795109039083);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:fleet', 1, 1795109039092);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:rate-buckets', 4, 1795109039107);
INSERT INTO atomic.atomic_migrations (domain, version, applied_at) VALUES ('schema:resource-admission', 1, 1795109039122);


--
-- Data for Name: intercom_held_sends; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_known_sessions; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_leases; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_outbox; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_pending_asks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_released_asks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_restoring_reservation_counters; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.intercom_restoring_reservation_counters (name, value) VALUES ('order', 0);
INSERT INTO atomic.intercom_restoring_reservation_counters (name, value) VALUES ('token', 0);


--
-- Data for Name: intercom_restoring_reservations; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_restoring_wake_claims; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_sent_messages; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_session_bindings; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_settled_asks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: intercom_wakeups; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_blob_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_blobs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_entries; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.session_entries (session_id, seq, entry_id, entry_json, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-session-1', 1, 'm1', '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-11-01T09:30:05.000Z","message":{"role":"user","content":"hello from 0.9.90","timestamp":1790000000000}}', 1, 0);
INSERT INTO atomic.session_entries (session_id, seq, entry_id, entry_json, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-session-1', 2, 'w1', '{"type":"worktree_snapshot","id":"w1","parentId":"m1","timestamp":"2026-11-01T09:30:06.000Z","root":"/repo","snapshotId":"snap-session","snapshot":{"version":1,"id":"snap-session","root":"/repo","remotes":["https://example.com/acme/app.git"],"branch":"main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshot":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tree":"cccccccccccccccccccccccccccccccccccccccc","chain":[{"snapshot":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parent":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","patch":"cc4bc80df52ef1f22d5a81e65554a62484abf6e1bc51bf16e60121b660c3222d"}],"omitted":[],"createdAt":1790000000000}}', 2, 0);
INSERT INTO atomic.session_entries (session_id, seq, entry_id, entry_json, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-stage-session', 1, 's1', '{"type":"message","id":"s1","parentId":null,"timestamp":"2026-11-01T09:31:05.000Z","message":{"role":"user","content":"stage prompt","timestamp":1790000060000}}', 3, 0);


--
-- Data for Name: session_entry_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_meta; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.session_meta (schema_version) VALUES (1);


--
-- Data for Name: session_open; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_search_entries; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_search_state; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: session_search_texts; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.session_search_texts (session_id, seq, text_json) VALUES ('legacy-session-1', 1, '"hello from 0.9.90"');
INSERT INTO atomic.session_search_texts (session_id, seq, text_json) VALUES ('legacy-stage-session', 1, '"stage prompt"');


--
-- Data for Name: session_sessions; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.session_sessions (id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision, row_order) OVERRIDING SYSTEM VALUE VALUES ('legacy-session-1', '/repo', '2026-11-01T09:30:00.000Z', '{"type":"session","version":4,"id":"legacy-session-1","createdAt":"2026-11-01T09:30:00.000Z","cwd":"/repo"}', 0, 2, '2026-09-21T14:13:20.000Z', 1, '"hello from 0.9.90"', NULL, 0, NULL, NULL, '{"messageCount":1,"firstMessage":"hello from 0.9.90","hasName":false,"latestMessageTime":1790000000000,"resume":{"version":5,"epoch":"e2be363a-a544-4c08-b7d2-54fc7a70375e","latest":{},"fields":{},"firstChildren":{},"admissions":[],"delivered":[],"deliveryOps":[],"settled":[],"pending":{},"parks":{},"intents":[],"acks":[],"models":[],"assistants":[],"seq":2,"lastId":"w1","leafSeq":2,"jumps":[],"compactions":[],"state":"2","universal":[2],"lastStateSeq":2,"totals":{"assistant":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"toolResult":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"summaries":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"userMessages":1,"assistantMessages":0,"toolResults":0,"totalMessages":1,"toolCalls":0}},"epoch":"e2be363a-a544-4c08-b7d2-54fc7a70375e"}', '8fd6cf5cbaec08be727aba1a6b232822', 1);
INSERT INTO atomic.session_sessions (id, cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state, revision, row_order) OVERRIDING SYSTEM VALUE VALUES ('legacy-stage-session', '/repo', '2026-11-01T09:31:00.000Z', '{"type":"session","version":4,"id":"legacy-stage-session","createdAt":"2026-11-01T09:31:00.000Z","cwd":"/repo","internal":true,"workflow":{"runId":"legacy-run-1","stageId":"stage-build","stageName":"build"}}', 1, 1, '2026-09-21T14:14:20.000Z', 1, '"stage prompt"', NULL, 0, NULL, NULL, '{"messageCount":1,"firstMessage":"stage prompt","hasName":false,"latestMessageTime":1790000060000,"resume":{"version":5,"epoch":"53bc9ca9-9368-42dc-9b7d-62b4cf8c9357","latest":{},"fields":{},"firstChildren":{},"admissions":[],"delivered":[],"deliveryOps":[],"settled":[],"pending":{},"parks":{},"intents":[],"acks":[],"models":[],"assistants":[],"seq":1,"lastId":"s1","leafSeq":1,"jumps":[],"compactions":[],"state":"","universal":[],"lastStateSeq":0,"totals":{"assistant":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"toolResult":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"summaries":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"userMessages":1,"assistantMessages":0,"toolResults":0,"totalMessages":1,"toolCalls":0}},"epoch":"53bc9ca9-9368-42dc-9b7d-62b4cf8c9357"}', 'ef47f71c60c9cb5a7b30e22bb638a1c1', 2);


--
-- Data for Name: snapshot_blob_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: snapshot_blobs; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES ('3254f7ba750c24f9188363dcf05df7f3067d74f8a0b82f26a3b34669fcfc032b', 17, '\x6c65676163792072756e2070617463680a', 1795109039, 0);
INSERT INTO atomic.snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES ('bd4bdfed482f4b0642c2529f61e4703fec533c93d3d9826a3b9f99540aed0856', 18, '\x6c65676163792072756e2062756e646c650a', 1795109039, 0);
INSERT INTO atomic.snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES ('cc4bc80df52ef1f22d5a81e65554a62484abf6e1bc51bf16e60121b660c3222d', 21, '\x6c65676163792073657373696f6e2070617463680a', 1795109039, 0);


--
-- Data for Name: snapshot_carried_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: snapshot_collection; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_collection (id, claimed_at, holder, finished_at, deleted, error_code) VALUES (1, NULL, NULL, NULL, NULL, NULL);


--
-- Data for Name: snapshot_index_sources; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries', 0, 0);
INSERT INTO atomic.snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries@own-progress', 0, 0);
INSERT INTO atomic.snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries@degraded-pins', 1, 1);
INSERT INTO atomic.snapshot_index_sources (source, watermark, backfilled_through) VALUES ('journal-events', 0, 0);
INSERT INTO atomic.snapshot_index_sources (source, watermark, backfilled_through) VALUES ('journal-runs', 0, 0);


--
-- Data for Name: snapshot_run_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_run_refs (run_id, hash) VALUES ('legacy-run-1', '3254f7ba750c24f9188363dcf05df7f3067d74f8a0b82f26a3b34669fcfc032b');
INSERT INTO atomic.snapshot_run_refs (run_id, hash) VALUES ('legacy-run-1', 'bd4bdfed482f4b0642c2529f61e4703fec533c93d3d9826a3b9f99540aed0856');


--
-- Data for Name: snapshot_run_state; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_run_state (run_id, retained, seq) VALUES ('legacy-run-1', 1, 3);


--
-- Data for Name: snapshot_session_links; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) VALUES ('legacy-session-1', 1, 'm1', NULL, NULL, 1, 0);
INSERT INTO atomic.snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) VALUES ('legacy-session-1', 2, 'w1', 'm1', 2, 0, 0);
INSERT INTO atomic.snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) VALUES ('legacy-stage-session', 1, 's1', NULL, NULL, 0, 0);


--
-- Data for Name: snapshot_session_records; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_session_records (session_id, seq, snapshot_id, hash) VALUES ('legacy-session-1', 2, 'snap-session', 'cc4bc80df52ef1f22d5a81e65554a62484abf6e1bc51bf16e60121b660c3222d');


--
-- Data for Name: snapshot_session_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.snapshot_session_refs (session_id, seq, root, snapshot_id, prev_seq, restore_from, restore_to, degraded_from, degraded_since) VALUES ('legacy-session-1', 2, '/repo', 'snap-session', NULL, NULL, NULL, NULL, NULL);


--
-- Data for Name: wf_event_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_events; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_events (run_id, seq, epoch, key, type, payload, at, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-run-1', 1, 1, NULL, 'RunStarted', '{"workflowId":"legacy-run-1"}', 1795109039212, 1, 0);
INSERT INTO atomic.wf_events (run_id, seq, epoch, key, type, payload, at, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-run-1', 2, 1, '["CheckpointRecorded","tool","build"]', 'CheckpointRecorded', '{"kind":"tool","name":"build","output":"ok","completedAt":1790000000500,"worktreeSnapshots":[{"version":1,"id":"snap-run","root":"/repo","remotes":["https://example.com/acme/app.git"],"branch":"main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshot":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tree":"cccccccccccccccccccccccccccccccccccccccc","chain":[{"snapshot":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parent":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","patch":"3254f7ba750c24f9188363dcf05df7f3067d74f8a0b82f26a3b34669fcfc032b"}],"bundle":{"blob":"bd4bdfed482f4b0642c2529f61e4703fec533c93d3d9826a3b9f99540aed0856","commits":["dddddddddddddddddddddddddddddddddddddddd"]},"omitted":[],"createdAt":1790000000000}]}', 1795109039214, 2, 0);
INSERT INTO atomic.wf_events (run_id, seq, epoch, key, type, payload, at, row_order, chunks) OVERRIDING SYSTEM VALUE VALUES ('legacy-run-1', 3, 1, NULL, 'StatusChanged', '{"workflowId":"legacy-run-1","status":"paused","completedCheckpoints":1,"pendingPrompts":0}', 1795109039216, 3, 0);


--
-- Data for Name: wf_lease_builds; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_lease_builds (run_id, holder_id, epoch, schema_version) VALUES ('legacy-run-1', 'legacy-holder', 1, 2);


--
-- Data for Name: wf_leases; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_leases (run_id, holder_id, epoch, renewed_at) VALUES ('legacy-run-1', NULL, 1, 1795109039210);


--
-- Data for Name: wf_meta; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_meta (schema_version) VALUES (2);


--
-- Data for Name: wf_ps_atomic_migrations; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('sessions', 1, 1795109039135);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('sessions', 2, 1795109039139);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('session-presence', 1, 1795109039143);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('session-presence', 2, 1795109039144);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 1, 1795109039183);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 2, 1795109039188);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 3, 1795109039194);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 4, 1795109039196);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('snapshot-blobs', 5, 1795109039198);
INSERT INTO atomic.wf_ps_atomic_migrations (domain, version, applied_at) VALUES ('session-search', 1, 1795109039206);


--
-- Data for Name: wf_ps_session_blob_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_blobs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_entries; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_entry_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_meta; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_ps_session_meta (schema_version) VALUES (1);


--
-- Data for Name: wf_ps_session_open; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_owners; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_search_entries; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_search_state; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_search_texts; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_session_sessions; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_blob_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_blobs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_carried_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_collection; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_ps_snapshot_collection (id, claimed_at, holder, finished_at, deleted, error_code) VALUES (1, NULL, NULL, NULL, NULL, NULL);


--
-- Data for Name: wf_ps_snapshot_index_sources; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_ps_snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries', 0, 0);
INSERT INTO atomic.wf_ps_snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries@own-progress', 0, 0);
INSERT INTO atomic.wf_ps_snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries@degraded-pins', 1, 1);


--
-- Data for Name: wf_ps_snapshot_run_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_run_state; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_session_links; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_session_records; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_ps_snapshot_session_refs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_runs (run_id, name, cwd, created_at, status, header_json, row_order) OVERRIDING SYSTEM VALUE VALUES ('legacy-run-1', 'legacy-workflow', '/repo', 1790000000000, 'paused', '{"runId":"legacy-run-1","name":"legacy-workflow","cwd":"/repo","createdAt":1790000000000,"status":"running","inputs":{"task":"legacy"}}', 1);


--
-- Data for Name: wf_runs_fleet_controller; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_fleet_drains; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_fleet_events; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_activity; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_control; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_fence; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_hosts; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_meta; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_runs_pool_meta (version) VALUES (3);


--
-- Data for Name: wf_runs_pool_operations; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_restore_backoffs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_root_snapshot; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_shared; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_usage; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_pool_usage_totals; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_rate_buckets; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_rate_waiting; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_resource_limits; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_resource_owners; Type: TABLE DATA; Schema: atomic; Owner: -
--

INSERT INTO atomic.wf_runs_resource_owners (id, host, pid, expires_at, boot) VALUES ('f9132015-add8-4c2c-b411-adb6893b170a', 'devbox', 670197, 1795109069122, 'b7d303ab-0bb8-4c5a-a7b5-f4aa25d76c1f');


--
-- Data for Name: wf_runs_resource_permits; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_ship_batches; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_ship_watermarks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_stage_inputs; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_stage_leases; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_stage_workspaces; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_work; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_work_input_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_work_result_chunks; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Data for Name: wf_runs_work_results; Type: TABLE DATA; Schema: atomic; Owner: -
--



--
-- Name: intercom_held_sends_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_held_sends_order_seq', 1, false);


--
-- Name: intercom_known_sessions_record_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_known_sessions_record_order_seq', 1, false);


--
-- Name: intercom_outbox_sequence_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_outbox_sequence_seq', 1, false);


--
-- Name: intercom_pending_asks_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_pending_asks_order_seq', 1, false);


--
-- Name: intercom_released_asks_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_released_asks_order_seq', 1, false);


--
-- Name: intercom_wakeups_id_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.intercom_wakeups_id_seq', 1, false);


--
-- Name: session_entries_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.session_entries_row_order_seq', 3, true);


--
-- Name: session_search_state_sid_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.session_search_state_sid_seq', 1, false);


--
-- Name: session_sessions_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.session_sessions_row_order_seq', 2, true);


--
-- Name: wf_events_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_events_row_order_seq', 3, true);


--
-- Name: wf_ps_session_entries_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_ps_session_entries_row_order_seq', 1, false);


--
-- Name: wf_ps_session_search_state_sid_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_ps_session_search_state_sid_seq', 1, false);


--
-- Name: wf_ps_session_sessions_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_ps_session_sessions_row_order_seq', 1, false);


--
-- Name: wf_runs_fleet_events_seq_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_fleet_events_seq_seq', 1, false);


--
-- Name: wf_runs_pool_restore_backoffs_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_pool_restore_backoffs_row_order_seq', 1, false);


--
-- Name: wf_runs_pool_root_snapshot_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_pool_root_snapshot_row_order_seq', 1, false);


--
-- Name: wf_runs_pool_shared_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_pool_shared_row_order_seq', 1, false);


--
-- Name: wf_runs_resource_permits_ticket_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_resource_permits_ticket_seq', 1, false);


--
-- Name: wf_runs_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_row_order_seq', 1, true);


--
-- Name: wf_runs_ship_batches_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_ship_batches_row_order_seq', 1, false);


--
-- Name: wf_runs_ship_watermarks_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_ship_watermarks_row_order_seq', 1, false);


--
-- Name: wf_runs_work_row_order_seq; Type: SEQUENCE SET; Schema: atomic; Owner: -
--

SELECT pg_catalog.setval('atomic.wf_runs_work_row_order_seq', 1, false);


--
-- Name: atomic_migrations atomic_migrations_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.atomic_migrations
    ADD CONSTRAINT atomic_migrations_pkey PRIMARY KEY (domain, version);


--
-- Name: intercom_held_sends intercom_held_sends_message_id_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_held_sends
    ADD CONSTRAINT intercom_held_sends_message_id_key UNIQUE (message_id);


--
-- Name: intercom_held_sends intercom_held_sends_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_held_sends
    ADD CONSTRAINT intercom_held_sends_pkey PRIMARY KEY ("order");


--
-- Name: intercom_known_sessions intercom_known_sessions_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_known_sessions
    ADD CONSTRAINT intercom_known_sessions_pkey PRIMARY KEY (record_order);


--
-- Name: intercom_known_sessions intercom_known_sessions_target_identity_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_known_sessions
    ADD CONSTRAINT intercom_known_sessions_target_identity_key UNIQUE (target_identity);


--
-- Name: intercom_leases intercom_leases_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_leases
    ADD CONSTRAINT intercom_leases_pkey PRIMARY KEY (kind, key);


--
-- Name: intercom_outbox intercom_outbox_message_id_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_outbox
    ADD CONSTRAINT intercom_outbox_message_id_key UNIQUE (message_id);


--
-- Name: intercom_outbox intercom_outbox_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_outbox
    ADD CONSTRAINT intercom_outbox_pkey PRIMARY KEY (sequence);


--
-- Name: intercom_pending_asks intercom_pending_asks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_pending_asks
    ADD CONSTRAINT intercom_pending_asks_pkey PRIMARY KEY ("order");


--
-- Name: intercom_pending_asks intercom_pending_asks_sender_session_id_target_session_id_m_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_pending_asks
    ADD CONSTRAINT intercom_pending_asks_sender_session_id_target_session_id_m_key UNIQUE (sender_session_id, target_session_id, message_id);


--
-- Name: intercom_released_asks intercom_released_asks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_released_asks
    ADD CONSTRAINT intercom_released_asks_pkey PRIMARY KEY ("order");


--
-- Name: intercom_released_asks intercom_released_asks_question_id_replier_session_id_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_released_asks
    ADD CONSTRAINT intercom_released_asks_question_id_replier_session_id_key UNIQUE (question_id, replier_session_id);


--
-- Name: intercom_restoring_reservation_counters intercom_restoring_reservation_counters_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_restoring_reservation_counters
    ADD CONSTRAINT intercom_restoring_reservation_counters_pkey PRIMARY KEY (name);


--
-- Name: intercom_restoring_reservations intercom_restoring_reservations_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_restoring_reservations
    ADD CONSTRAINT intercom_restoring_reservations_pkey PRIMARY KEY (reservation_key);


--
-- Name: intercom_restoring_wake_claims intercom_restoring_wake_claims_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_restoring_wake_claims
    ADD CONSTRAINT intercom_restoring_wake_claims_pkey PRIMARY KEY (reservation_key, fencing_token, message_id);


--
-- Name: intercom_sent_messages intercom_sent_messages_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_sent_messages
    ADD CONSTRAINT intercom_sent_messages_pkey PRIMARY KEY (message_id);


--
-- Name: intercom_session_bindings intercom_session_bindings_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_session_bindings
    ADD CONSTRAINT intercom_session_bindings_pkey PRIMARY KEY (intercom_session_id);


--
-- Name: intercom_settled_asks intercom_settled_asks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_settled_asks
    ADD CONSTRAINT intercom_settled_asks_pkey PRIMARY KEY (sender_session_id, target_session_id, message_id);


--
-- Name: intercom_wakeups intercom_wakeups_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.intercom_wakeups
    ADD CONSTRAINT intercom_wakeups_pkey PRIMARY KEY (id);


--
-- Name: session_blob_chunks session_blob_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_blob_chunks
    ADD CONSTRAINT session_blob_chunks_pkey PRIMARY KEY (session_id, hash, idx);


--
-- Name: session_blobs session_blobs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_blobs
    ADD CONSTRAINT session_blobs_pkey PRIMARY KEY (session_id, hash);


--
-- Name: session_entries session_entries_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_entries
    ADD CONSTRAINT session_entries_pkey PRIMARY KEY (session_id, seq);


--
-- Name: session_entries session_entries_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_entries
    ADD CONSTRAINT session_entries_row_order_key UNIQUE (row_order);


--
-- Name: session_entry_chunks session_entry_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_entry_chunks
    ADD CONSTRAINT session_entry_chunks_pkey PRIMARY KEY (session_id, seq, idx);


--
-- Name: session_open session_open_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_open
    ADD CONSTRAINT session_open_pkey PRIMARY KEY (session_id, token);


--
-- Name: session_search_entries session_search_entries_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_search_entries
    ADD CONSTRAINT session_search_entries_pkey PRIMARY KEY (sid, seq, part);


--
-- Name: session_search_state session_search_state_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_search_state
    ADD CONSTRAINT session_search_state_pkey PRIMARY KEY (sid);


--
-- Name: session_search_state session_search_state_session_id_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_search_state
    ADD CONSTRAINT session_search_state_session_id_key UNIQUE (session_id);


--
-- Name: session_search_texts session_search_texts_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_search_texts
    ADD CONSTRAINT session_search_texts_pkey PRIMARY KEY (session_id, seq);


--
-- Name: session_sessions session_sessions_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_sessions
    ADD CONSTRAINT session_sessions_pkey PRIMARY KEY (id);


--
-- Name: session_sessions session_sessions_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.session_sessions
    ADD CONSTRAINT session_sessions_row_order_key UNIQUE (row_order);


--
-- Name: snapshot_blob_chunks snapshot_blob_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_blob_chunks
    ADD CONSTRAINT snapshot_blob_chunks_pkey PRIMARY KEY (hash, idx);


--
-- Name: snapshot_blobs snapshot_blobs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_blobs
    ADD CONSTRAINT snapshot_blobs_pkey PRIMARY KEY (hash);


--
-- Name: snapshot_carried_refs snapshot_carried_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_carried_refs
    ADD CONSTRAINT snapshot_carried_refs_pkey PRIMARY KEY (owner, hash);


--
-- Name: snapshot_collection snapshot_collection_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_collection
    ADD CONSTRAINT snapshot_collection_pkey PRIMARY KEY (id);


--
-- Name: snapshot_index_sources snapshot_index_sources_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_index_sources
    ADD CONSTRAINT snapshot_index_sources_pkey PRIMARY KEY (source);


--
-- Name: snapshot_run_refs snapshot_run_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_run_refs
    ADD CONSTRAINT snapshot_run_refs_pkey PRIMARY KEY (run_id, hash);


--
-- Name: snapshot_run_state snapshot_run_state_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_run_state
    ADD CONSTRAINT snapshot_run_state_pkey PRIMARY KEY (run_id);


--
-- Name: snapshot_session_links snapshot_session_links_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_session_links
    ADD CONSTRAINT snapshot_session_links_pkey PRIMARY KEY (session_id, seq);


--
-- Name: snapshot_session_records snapshot_session_records_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_session_records
    ADD CONSTRAINT snapshot_session_records_pkey PRIMARY KEY (session_id, seq, hash);


--
-- Name: snapshot_session_refs snapshot_session_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.snapshot_session_refs
    ADD CONSTRAINT snapshot_session_refs_pkey PRIMARY KEY (session_id, seq);


--
-- Name: wf_event_chunks wf_event_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_event_chunks
    ADD CONSTRAINT wf_event_chunks_pkey PRIMARY KEY (run_id, seq, idx);


--
-- Name: wf_events wf_events_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_events
    ADD CONSTRAINT wf_events_pkey PRIMARY KEY (run_id, seq);


--
-- Name: wf_events wf_events_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_events
    ADD CONSTRAINT wf_events_row_order_key UNIQUE (row_order);


--
-- Name: wf_events wf_events_run_id_key_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_events
    ADD CONSTRAINT wf_events_run_id_key_key UNIQUE (run_id, key);


--
-- Name: wf_lease_builds wf_lease_builds_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_lease_builds
    ADD CONSTRAINT wf_lease_builds_pkey PRIMARY KEY (run_id);


--
-- Name: wf_leases wf_leases_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_leases
    ADD CONSTRAINT wf_leases_pkey PRIMARY KEY (run_id);


--
-- Name: wf_ps_atomic_migrations wf_ps_atomic_migrations_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_atomic_migrations
    ADD CONSTRAINT wf_ps_atomic_migrations_pkey PRIMARY KEY (domain, version);


--
-- Name: wf_ps_session_blob_chunks wf_ps_session_blob_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_blob_chunks
    ADD CONSTRAINT wf_ps_session_blob_chunks_pkey PRIMARY KEY (session_id, hash, idx);


--
-- Name: wf_ps_session_blobs wf_ps_session_blobs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_blobs
    ADD CONSTRAINT wf_ps_session_blobs_pkey PRIMARY KEY (session_id, hash);


--
-- Name: wf_ps_session_entries wf_ps_session_entries_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_entries
    ADD CONSTRAINT wf_ps_session_entries_pkey PRIMARY KEY (session_id, seq);


--
-- Name: wf_ps_session_entries wf_ps_session_entries_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_entries
    ADD CONSTRAINT wf_ps_session_entries_row_order_key UNIQUE (row_order);


--
-- Name: wf_ps_session_entry_chunks wf_ps_session_entry_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_entry_chunks
    ADD CONSTRAINT wf_ps_session_entry_chunks_pkey PRIMARY KEY (session_id, seq, idx);


--
-- Name: wf_ps_session_open wf_ps_session_open_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_open
    ADD CONSTRAINT wf_ps_session_open_pkey PRIMARY KEY (session_id, token);


--
-- Name: wf_ps_session_owners wf_ps_session_owners_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_owners
    ADD CONSTRAINT wf_ps_session_owners_pkey PRIMARY KEY (session);


--
-- Name: wf_ps_session_search_entries wf_ps_session_search_entries_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_search_entries
    ADD CONSTRAINT wf_ps_session_search_entries_pkey PRIMARY KEY (sid, seq, part);


--
-- Name: wf_ps_session_search_state wf_ps_session_search_state_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_search_state
    ADD CONSTRAINT wf_ps_session_search_state_pkey PRIMARY KEY (sid);


--
-- Name: wf_ps_session_search_state wf_ps_session_search_state_session_id_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_search_state
    ADD CONSTRAINT wf_ps_session_search_state_session_id_key UNIQUE (session_id);


--
-- Name: wf_ps_session_search_texts wf_ps_session_search_texts_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_search_texts
    ADD CONSTRAINT wf_ps_session_search_texts_pkey PRIMARY KEY (session_id, seq);


--
-- Name: wf_ps_session_sessions wf_ps_session_sessions_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_sessions
    ADD CONSTRAINT wf_ps_session_sessions_pkey PRIMARY KEY (id);


--
-- Name: wf_ps_session_sessions wf_ps_session_sessions_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_sessions
    ADD CONSTRAINT wf_ps_session_sessions_row_order_key UNIQUE (row_order);


--
-- Name: wf_ps_snapshot_blob_chunks wf_ps_snapshot_blob_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_blob_chunks
    ADD CONSTRAINT wf_ps_snapshot_blob_chunks_pkey PRIMARY KEY (hash, idx);


--
-- Name: wf_ps_snapshot_blobs wf_ps_snapshot_blobs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_blobs
    ADD CONSTRAINT wf_ps_snapshot_blobs_pkey PRIMARY KEY (hash);


--
-- Name: wf_ps_snapshot_carried_refs wf_ps_snapshot_carried_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_carried_refs
    ADD CONSTRAINT wf_ps_snapshot_carried_refs_pkey PRIMARY KEY (owner, hash);


--
-- Name: wf_ps_snapshot_collection wf_ps_snapshot_collection_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_collection
    ADD CONSTRAINT wf_ps_snapshot_collection_pkey PRIMARY KEY (id);


--
-- Name: wf_ps_snapshot_index_sources wf_ps_snapshot_index_sources_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_index_sources
    ADD CONSTRAINT wf_ps_snapshot_index_sources_pkey PRIMARY KEY (source);


--
-- Name: wf_ps_snapshot_run_refs wf_ps_snapshot_run_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_run_refs
    ADD CONSTRAINT wf_ps_snapshot_run_refs_pkey PRIMARY KEY (run_id, hash);


--
-- Name: wf_ps_snapshot_run_state wf_ps_snapshot_run_state_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_run_state
    ADD CONSTRAINT wf_ps_snapshot_run_state_pkey PRIMARY KEY (run_id);


--
-- Name: wf_ps_snapshot_session_links wf_ps_snapshot_session_links_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_session_links
    ADD CONSTRAINT wf_ps_snapshot_session_links_pkey PRIMARY KEY (session_id, seq);


--
-- Name: wf_ps_snapshot_session_records wf_ps_snapshot_session_records_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_session_records
    ADD CONSTRAINT wf_ps_snapshot_session_records_pkey PRIMARY KEY (session_id, seq, hash);


--
-- Name: wf_ps_snapshot_session_refs wf_ps_snapshot_session_refs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_snapshot_session_refs
    ADD CONSTRAINT wf_ps_snapshot_session_refs_pkey PRIMARY KEY (session_id, seq);


--
-- Name: wf_runs_fleet_controller wf_runs_fleet_controller_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_fleet_controller
    ADD CONSTRAINT wf_runs_fleet_controller_pkey PRIMARY KEY (id);


--
-- Name: wf_runs_fleet_drains wf_runs_fleet_drains_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_fleet_drains
    ADD CONSTRAINT wf_runs_fleet_drains_pkey PRIMARY KEY (host);


--
-- Name: wf_runs_fleet_events wf_runs_fleet_events_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_fleet_events
    ADD CONSTRAINT wf_runs_fleet_events_pkey PRIMARY KEY (seq);


--
-- Name: wf_runs wf_runs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs
    ADD CONSTRAINT wf_runs_pkey PRIMARY KEY (run_id);


--
-- Name: wf_runs_pool_activity wf_runs_pool_activity_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_activity
    ADD CONSTRAINT wf_runs_pool_activity_pkey PRIMARY KEY (work);


--
-- Name: wf_runs_pool_control wf_runs_pool_control_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_control
    ADD CONSTRAINT wf_runs_pool_control_pkey PRIMARY KEY (root);


--
-- Name: wf_runs_pool_hosts wf_runs_pool_hosts_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_hosts
    ADD CONSTRAINT wf_runs_pool_hosts_pkey PRIMARY KEY (host);


--
-- Name: wf_runs_pool_operations wf_runs_pool_operations_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_operations
    ADD CONSTRAINT wf_runs_pool_operations_pkey PRIMARY KEY (work, generation, operation);


--
-- Name: wf_runs_pool wf_runs_pool_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool
    ADD CONSTRAINT wf_runs_pool_pkey PRIMARY KEY (root);


--
-- Name: wf_runs_pool_restore_backoffs wf_runs_pool_restore_backoffs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_restore_backoffs
    ADD CONSTRAINT wf_runs_pool_restore_backoffs_pkey PRIMARY KEY (host, binding);


--
-- Name: wf_runs_pool_restore_backoffs wf_runs_pool_restore_backoffs_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_restore_backoffs
    ADD CONSTRAINT wf_runs_pool_restore_backoffs_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_pool_root_snapshot wf_runs_pool_root_snapshot_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_root_snapshot
    ADD CONSTRAINT wf_runs_pool_root_snapshot_pkey PRIMARY KEY (root);


--
-- Name: wf_runs_pool_root_snapshot wf_runs_pool_root_snapshot_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_root_snapshot
    ADD CONSTRAINT wf_runs_pool_root_snapshot_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_pool_shared wf_runs_pool_shared_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_shared
    ADD CONSTRAINT wf_runs_pool_shared_pkey PRIMARY KEY (root);


--
-- Name: wf_runs_pool_shared wf_runs_pool_shared_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_shared
    ADD CONSTRAINT wf_runs_pool_shared_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_pool_usage wf_runs_pool_usage_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_usage
    ADD CONSTRAINT wf_runs_pool_usage_pkey PRIMARY KEY (work, generation, key);


--
-- Name: wf_runs_pool_usage_totals wf_runs_pool_usage_totals_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_usage_totals
    ADD CONSTRAINT wf_runs_pool_usage_totals_pkey PRIMARY KEY (root);


--
-- Name: wf_runs_rate_buckets wf_runs_rate_buckets_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_rate_buckets
    ADD CONSTRAINT wf_runs_rate_buckets_pkey PRIMARY KEY (scope);


--
-- Name: wf_runs_rate_waiting wf_runs_rate_waiting_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_rate_waiting
    ADD CONSTRAINT wf_runs_rate_waiting_pkey PRIMARY KEY (scope, reporter);


--
-- Name: wf_runs_resource_limits wf_runs_resource_limits_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_resource_limits
    ADD CONSTRAINT wf_runs_resource_limits_pkey PRIMARY KEY (scope);


--
-- Name: wf_runs_resource_owners wf_runs_resource_owners_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_resource_owners
    ADD CONSTRAINT wf_runs_resource_owners_pkey PRIMARY KEY (id);


--
-- Name: wf_runs_resource_permits wf_runs_resource_permits_operation_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_resource_permits
    ADD CONSTRAINT wf_runs_resource_permits_operation_key UNIQUE (operation);


--
-- Name: wf_runs_resource_permits wf_runs_resource_permits_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_resource_permits
    ADD CONSTRAINT wf_runs_resource_permits_pkey PRIMARY KEY (ticket);


--
-- Name: wf_runs wf_runs_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs
    ADD CONSTRAINT wf_runs_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_ship_batches wf_runs_ship_batches_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_batches
    ADD CONSTRAINT wf_runs_ship_batches_pkey PRIMARY KEY (batch);


--
-- Name: wf_runs_ship_batches wf_runs_ship_batches_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_batches
    ADD CONSTRAINT wf_runs_ship_batches_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_ship_watermarks wf_runs_ship_watermarks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_watermarks
    ADD CONSTRAINT wf_runs_ship_watermarks_pkey PRIMARY KEY (work);


--
-- Name: wf_runs_ship_watermarks wf_runs_ship_watermarks_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_watermarks
    ADD CONSTRAINT wf_runs_ship_watermarks_row_order_key UNIQUE (row_order);


--
-- Name: wf_runs_stage_inputs wf_runs_stage_inputs_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_inputs
    ADD CONSTRAINT wf_runs_stage_inputs_pkey PRIMARY KEY (root, run_id, stage_id, seq);


--
-- Name: wf_runs_stage_inputs wf_runs_stage_inputs_root_run_id_stage_id_op_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_inputs
    ADD CONSTRAINT wf_runs_stage_inputs_root_run_id_stage_id_op_key UNIQUE (root, run_id, stage_id, op);


--
-- Name: wf_runs_stage_leases wf_runs_stage_leases_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_leases
    ADD CONSTRAINT wf_runs_stage_leases_pkey PRIMARY KEY (root, run_id, stage_id);


--
-- Name: wf_runs_stage_workspaces wf_runs_stage_workspaces_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_workspaces
    ADD CONSTRAINT wf_runs_stage_workspaces_pkey PRIMARY KEY (root, run_id, stage_id);


--
-- Name: wf_runs_work_input_chunks wf_runs_work_input_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_input_chunks
    ADD CONSTRAINT wf_runs_work_input_chunks_pkey PRIMARY KEY (work, idx);


--
-- Name: wf_runs_work wf_runs_work_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work
    ADD CONSTRAINT wf_runs_work_pkey PRIMARY KEY (id);


--
-- Name: wf_runs_work_result_chunks wf_runs_work_result_chunks_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_result_chunks
    ADD CONSTRAINT wf_runs_work_result_chunks_pkey PRIMARY KEY (work, idx);


--
-- Name: wf_runs_work_results wf_runs_work_results_pkey; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_results
    ADD CONSTRAINT wf_runs_work_results_pkey PRIMARY KEY (work);


--
-- Name: wf_runs_work wf_runs_work_root_boundary_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work
    ADD CONSTRAINT wf_runs_work_root_boundary_key UNIQUE (root, boundary);


--
-- Name: wf_runs_work wf_runs_work_row_order_key; Type: CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work
    ADD CONSTRAINT wf_runs_work_row_order_key UNIQUE (row_order);


--
-- Name: intercom_held_sends_reservation; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_held_sends_reservation ON atomic.intercom_held_sends USING btree (reservation_key, "order");


--
-- Name: intercom_known_sessions_atomic_id; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_known_sessions_atomic_id ON atomic.intercom_known_sessions USING btree (atomic_session_id);


--
-- Name: intercom_known_sessions_intercom_id; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_known_sessions_intercom_id ON atomic.intercom_known_sessions USING btree (intercom_session_id);


--
-- Name: intercom_known_sessions_name; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_known_sessions_name ON atomic.intercom_known_sessions USING btree (name_key);


--
-- Name: intercom_known_sessions_recorded; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_known_sessions_recorded ON atomic.intercom_known_sessions USING btree (recorded_at);


--
-- Name: intercom_outbox_target; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_outbox_target ON atomic.intercom_outbox USING btree (target_identity, state, sequence);


--
-- Name: intercom_outbox_target_bytes; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_outbox_target_bytes ON atomic.intercom_outbox USING btree (target_identity, state, frame_bytes);


--
-- Name: intercom_pending_asks_target; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_pending_asks_target ON atomic.intercom_pending_asks USING btree (target_session_id, "order");


--
-- Name: intercom_restoring_reservations_active; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_restoring_reservations_active ON atomic.intercom_restoring_reservations USING btree (end_json, "order");


--
-- Name: intercom_restoring_reservations_child; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_restoring_reservations_child ON atomic.intercom_restoring_reservations USING btree (child_target) WHERE (end_json IS NULL);


--
-- Name: intercom_restoring_reservations_wake; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_restoring_reservations_wake ON atomic.intercom_restoring_reservations USING btree (owner_broker_id) WHERE (wake_requested = 1);


--
-- Name: intercom_sent_messages_recorded; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_sent_messages_recorded ON atomic.intercom_sent_messages USING btree (recorded_at);


--
-- Name: intercom_session_bindings_recorded; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_session_bindings_recorded ON atomic.intercom_session_bindings USING btree (recorded_at);


--
-- Name: intercom_settled_asks_at; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_settled_asks_at ON atomic.intercom_settled_asks USING btree (settled_at);


--
-- Name: intercom_wakeups_broker; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_wakeups_broker ON atomic.intercom_wakeups USING btree (broker_id, id);


--
-- Name: intercom_wakeups_created; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX intercom_wakeups_created ON atomic.intercom_wakeups USING btree (created_at);


--
-- Name: session_search_trgm; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX session_search_trgm ON atomic.session_search_entries USING gin (body atomic.gin_trgm_ops);


--
-- Name: snapshot_blobs_age; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_blobs_age ON atomic.snapshot_blobs USING btree (created_at, hash);


--
-- Name: snapshot_blobs_inline_size; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_blobs_inline_size ON atomic.snapshot_blobs USING btree (chunks, hash) WHERE ((chunks = 0) AND (length(data) > 1048576));


--
-- Name: snapshot_carried_refs_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_carried_refs_hash ON atomic.snapshot_carried_refs USING btree (hash);


--
-- Name: snapshot_run_refs_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_run_refs_hash ON atomic.snapshot_run_refs USING btree (hash);


--
-- Name: snapshot_session_links_broken; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_session_links_broken ON atomic.snapshot_session_links USING btree (session_id) WHERE (broken = 1);


--
-- Name: snapshot_session_links_entry; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_session_links_entry ON atomic.snapshot_session_links USING btree (session_id, entry_id);


--
-- Name: snapshot_session_links_leaves; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_session_links_leaves ON atomic.snapshot_session_links USING btree (session_id, anchor_seq) WHERE ((children = 0) AND (anchor_seq IS NOT NULL));


--
-- Name: snapshot_session_records_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX snapshot_session_records_hash ON atomic.snapshot_session_records USING btree (hash);


--
-- Name: wf_ps_session_search_trgm; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_session_search_trgm ON atomic.wf_ps_session_search_entries USING gin (body atomic.gin_trgm_ops);


--
-- Name: wf_ps_snapshot_blobs_age; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_blobs_age ON atomic.wf_ps_snapshot_blobs USING btree (created_at, hash);


--
-- Name: wf_ps_snapshot_blobs_inline_size; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_blobs_inline_size ON atomic.wf_ps_snapshot_blobs USING btree (chunks, hash) WHERE ((chunks = 0) AND (length(data) > 1048576));


--
-- Name: wf_ps_snapshot_carried_refs_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_carried_refs_hash ON atomic.wf_ps_snapshot_carried_refs USING btree (hash);


--
-- Name: wf_ps_snapshot_run_refs_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_run_refs_hash ON atomic.wf_ps_snapshot_run_refs USING btree (hash);


--
-- Name: wf_ps_snapshot_session_links_broken; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_session_links_broken ON atomic.wf_ps_snapshot_session_links USING btree (session_id) WHERE (broken = 1);


--
-- Name: wf_ps_snapshot_session_links_entry; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_session_links_entry ON atomic.wf_ps_snapshot_session_links USING btree (session_id, entry_id);


--
-- Name: wf_ps_snapshot_session_links_leaves; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_session_links_leaves ON atomic.wf_ps_snapshot_session_links USING btree (session_id, anchor_seq) WHERE ((children = 0) AND (anchor_seq IS NOT NULL));


--
-- Name: wf_ps_snapshot_session_records_hash; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_ps_snapshot_session_records_hash ON atomic.wf_ps_snapshot_session_records USING btree (hash);


--
-- Name: wf_runs_pool_activity_version; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_pool_activity_version ON atomic.wf_runs_pool_activity USING btree (version);


--
-- Name: wf_runs_rate_waiting_age; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_rate_waiting_age ON atomic.wf_runs_rate_waiting USING btree (scope, updated_at, reporter);


--
-- Name: wf_runs_resource_permits_active; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_resource_permits_active ON atomic.wf_runs_resource_permits USING btree (kind, state, root);


--
-- Name: wf_runs_resource_permits_owner; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_resource_permits_owner ON atomic.wf_runs_resource_permits USING btree (owner, state);


--
-- Name: wf_runs_resource_permits_state; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_resource_permits_state ON atomic.wf_runs_resource_permits USING btree (state);


--
-- Name: wf_runs_ship_batches_work; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_ship_batches_work ON atomic.wf_runs_ship_batches USING btree (work, generation);


--
-- Name: wf_runs_stage_inputs_pending; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_stage_inputs_pending ON atomic.wf_runs_stage_inputs USING btree (work, state);


--
-- Name: wf_runs_work_child; Type: INDEX; Schema: atomic; Owner: -
--

CREATE UNIQUE INDEX wf_runs_work_child ON atomic.wf_runs_work USING btree (root, (((regexp_replace(descriptor, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})'::text, '\1\\ufffd'::text, 'g'::text))::jsonb ->> 'childRunId'::text)));


--
-- Name: wf_runs_work_expiry; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_work_expiry ON atomic.wf_runs_work USING btree (state, expires_at);


--
-- Name: wf_runs_work_ready; Type: INDEX; Schema: atomic; Owner: -
--

CREATE INDEX wf_runs_work_ready ON atomic.wf_runs_work USING btree (root, state, ready_at);


--
-- Name: wf_runs_work_scope; Type: INDEX; Schema: atomic; Owner: -
--

CREATE UNIQUE INDEX wf_runs_work_scope ON atomic.wf_runs_work USING btree (root, (((regexp_replace(descriptor, '(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})'::text, '\1\\ufffd'::text, 'g'::text))::jsonb ->> 'scope'::text)));


--
-- Name: session_entries session_entries_search_forget; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER session_entries_search_forget AFTER DELETE ON atomic.session_entries FOR EACH ROW EXECUTE FUNCTION atomic.session_entries_search_forget_fn();


--
-- Name: session_entries session_entries_snapshot_links; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER session_entries_snapshot_links AFTER INSERT ON atomic.session_entries FOR EACH ROW EXECUTE FUNCTION atomic.session_entries_snapshot_links_fn();


--
-- Name: session_entries session_entries_snapshot_pending; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER session_entries_snapshot_pending AFTER INSERT ON atomic.session_entries FOR EACH ROW EXECUTE FUNCTION atomic.session_entries_snapshot_pending_fn();


--
-- Name: session_entries session_entries_snapshot_refs; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER session_entries_snapshot_refs AFTER INSERT ON atomic.session_entries FOR EACH ROW EXECUTE FUNCTION atomic.session_entries_snapshot_refs_fn();


--
-- Name: session_entries session_entries_snapshot_refs_delete; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER session_entries_snapshot_refs_delete AFTER DELETE ON atomic.session_entries FOR EACH ROW EXECUTE FUNCTION atomic.session_entries_snapshot_refs_delete_fn();


--
-- Name: snapshot_blobs snapshot_blobs_chunks_delete_all; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER snapshot_blobs_chunks_delete_all AFTER DELETE ON atomic.snapshot_blobs FOR EACH ROW EXECUTE FUNCTION atomic.snapshot_blobs_chunks_delete_all_fn();


--
-- Name: wf_events wf_events_snapshot_refs; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_events_snapshot_refs AFTER INSERT ON atomic.wf_events FOR EACH ROW EXECUTE FUNCTION atomic.wf_events_snapshot_refs_fn();


--
-- Name: wf_events wf_events_snapshot_state; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_events_snapshot_state AFTER INSERT ON atomic.wf_events FOR EACH ROW EXECUTE FUNCTION atomic.wf_events_snapshot_state_fn();


--
-- Name: wf_ps_session_entries wf_ps_session_entries_search_forget; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_session_entries_search_forget AFTER DELETE ON atomic.wf_ps_session_entries FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_session_entries_search_forget_fn();


--
-- Name: wf_ps_session_entries wf_ps_session_entries_snapshot_links; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_session_entries_snapshot_links AFTER INSERT ON atomic.wf_ps_session_entries FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_session_entries_snapshot_links_fn();


--
-- Name: wf_ps_session_entries wf_ps_session_entries_snapshot_pending; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_session_entries_snapshot_pending AFTER INSERT ON atomic.wf_ps_session_entries FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_session_entries_snapshot_pending_fn();


--
-- Name: wf_ps_session_entries wf_ps_session_entries_snapshot_refs; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_session_entries_snapshot_refs AFTER INSERT ON atomic.wf_ps_session_entries FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_session_entries_snapshot_refs_fn();


--
-- Name: wf_ps_session_entries wf_ps_session_entries_snapshot_refs_delete; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_session_entries_snapshot_refs_delete AFTER DELETE ON atomic.wf_ps_session_entries FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_session_entries_snapshot_refs_delete_fn();


--
-- Name: wf_ps_snapshot_blobs wf_ps_snapshot_blobs_chunks_delete_all; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_ps_snapshot_blobs_chunks_delete_all AFTER DELETE ON atomic.wf_ps_snapshot_blobs FOR EACH ROW EXECUTE FUNCTION atomic.wf_ps_snapshot_blobs_chunks_delete_all_fn();


--
-- Name: wf_runs_pool_fence wf_runs_pool_fence_abort; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_pool_fence_abort BEFORE INSERT ON atomic.wf_runs_pool_fence FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_pool_fence_abort_fn();


--
-- Name: wf_runs_pool_usage wf_runs_pool_usage_totals_delete; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_pool_usage_totals_delete AFTER DELETE ON atomic.wf_runs_pool_usage FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_pool_usage_totals_delete_fn();


--
-- Name: wf_runs_pool_usage wf_runs_pool_usage_totals_insert; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_pool_usage_totals_insert AFTER INSERT ON atomic.wf_runs_pool_usage FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_pool_usage_totals_insert_fn();


--
-- Name: wf_runs_pool_usage wf_runs_pool_usage_totals_update; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_pool_usage_totals_update AFTER UPDATE ON atomic.wf_runs_pool_usage FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_pool_usage_totals_update_fn();


--
-- Name: wf_runs_work wf_runs_pool_usage_totals_work_delete; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_pool_usage_totals_work_delete BEFORE DELETE ON atomic.wf_runs_work FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_pool_usage_totals_work_delete_fn();


--
-- Name: wf_runs wf_runs_snapshot_refs_delete; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_snapshot_refs_delete AFTER DELETE ON atomic.wf_runs FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_snapshot_refs_delete_fn();


--
-- Name: wf_runs wf_runs_snapshot_state_insert; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_snapshot_state_insert AFTER INSERT ON atomic.wf_runs FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_snapshot_state_insert_fn();


--
-- Name: wf_runs wf_runs_snapshot_state_status; Type: TRIGGER; Schema: atomic; Owner: -
--

CREATE TRIGGER wf_runs_snapshot_state_status AFTER UPDATE OF status ON atomic.wf_runs FOR EACH ROW EXECUTE FUNCTION atomic.wf_runs_snapshot_state_status_fn();


--
-- Name: wf_ps_session_owners wf_ps_session_owners_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_ps_session_owners
    ADD CONSTRAINT wf_ps_session_owners_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_activity wf_runs_pool_activity_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_activity
    ADD CONSTRAINT wf_runs_pool_activity_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_control wf_runs_pool_control_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_control
    ADD CONSTRAINT wf_runs_pool_control_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs_pool(root) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_operations wf_runs_pool_operations_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_operations
    ADD CONSTRAINT wf_runs_pool_operations_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_pool wf_runs_pool_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool
    ADD CONSTRAINT wf_runs_pool_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs(run_id) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_root_snapshot wf_runs_pool_root_snapshot_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_root_snapshot
    ADD CONSTRAINT wf_runs_pool_root_snapshot_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs(run_id) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_shared wf_runs_pool_shared_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_shared
    ADD CONSTRAINT wf_runs_pool_shared_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs_pool(root) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_usage_totals wf_runs_pool_usage_totals_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_usage_totals
    ADD CONSTRAINT wf_runs_pool_usage_totals_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs_pool(root) ON DELETE CASCADE;


--
-- Name: wf_runs_pool_usage wf_runs_pool_usage_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_pool_usage
    ADD CONSTRAINT wf_runs_pool_usage_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_ship_batches wf_runs_ship_batches_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_batches
    ADD CONSTRAINT wf_runs_ship_batches_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_ship_watermarks wf_runs_ship_watermarks_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_ship_watermarks
    ADD CONSTRAINT wf_runs_ship_watermarks_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_stage_inputs wf_runs_stage_inputs_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_inputs
    ADD CONSTRAINT wf_runs_stage_inputs_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_stage_workspaces wf_runs_stage_workspaces_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_stage_workspaces
    ADD CONSTRAINT wf_runs_stage_workspaces_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_work_input_chunks wf_runs_work_input_chunks_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_input_chunks
    ADD CONSTRAINT wf_runs_work_input_chunks_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_work_result_chunks wf_runs_work_result_chunks_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_result_chunks
    ADD CONSTRAINT wf_runs_work_result_chunks_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work_results(work) ON DELETE CASCADE;


--
-- Name: wf_runs_work_results wf_runs_work_results_work_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work_results
    ADD CONSTRAINT wf_runs_work_results_work_fkey FOREIGN KEY (work) REFERENCES atomic.wf_runs_work(id) ON DELETE CASCADE;


--
-- Name: wf_runs_work wf_runs_work_root_fkey; Type: FK CONSTRAINT; Schema: atomic; Owner: -
--

ALTER TABLE ONLY atomic.wf_runs_work
    ADD CONSTRAINT wf_runs_work_root_fkey FOREIGN KEY (root) REFERENCES atomic.wf_runs_pool(root) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict zOUXBgiT81uKMPCjcuczfgcIp56tQlU4AXMiBlFSgmxdzhwWzbBA5G83fEtw69l

