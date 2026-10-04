import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface DbosRowAuthority {
	readonly root: string;
	readonly actor: string;
	readonly owner?: string;
	readonly generation?: number;
	readonly claim?: string;
	readonly checkpoint?: string;
	readonly enroll?: boolean;
}

export async function installDbosRowGuard(client: PoolClient): Promise<void> {
	const ready = await client.query<{ status: boolean; operations: boolean }>(
		"SELECT to_regclass('dbos.workflow_status') IS NOT NULL AS status, to_regclass('dbos.operation_outputs') IS NOT NULL AS operations",
	);
	if (!ready.rows[0]?.status && !ready.rows[0]?.operations) return;
	if (!ready.rows[0]?.status || !ready.rows[0]?.operations)
		throw new Error("Atomic workflow database schema is incomplete");
	if (await validateInstalledGuard(client)) return;
	await client.query("BEGIN");
	try {
		await client.query("SELECT pg_advisory_xact_lock(3419, 9003)");
		if (await validateInstalledGuard(client)) {
			await client.query("COMMIT");
			return;
		}
		await client.query(guardSql);
		await client.query(
			"CREATE TABLE IF NOT EXISTS dbos.atomic_guard_protocol (singleton boolean PRIMARY KEY CHECK(singleton), fingerprint text NOT NULL)",
		);
		await client.query("INSERT INTO dbos.atomic_guard_protocol VALUES (true, $1) ON CONFLICT DO NOTHING", [
			fingerprint,
		]);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}
async function validateInstalledGuard(client: PoolClient): Promise<boolean> {
	const installed = await client.query<{ present: boolean }>(
		"SELECT to_regclass('dbos.atomic_guard_protocol') IS NOT NULL AS present",
	);
	if (!installed.rows[0]?.present) return false;
	const validated = await client.query<{ fingerprint: string; triggers: number; projections: number }>(
		"SELECT fingerprint, (SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN ('dbos.workflow_status'::regclass,'dbos.operation_outputs'::regclass) AND tgname = 'atomic_generation_guard' AND tgenabled = 'O' AND tgtype = 31 AND tgfoid = 'dbos.atomic_guard_row()'::regprocedure) AS triggers, (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'dbos.workflow_status'::regclass AND tgname = 'atomic_generation_projection' AND tgenabled = 'O' AND tgtype = 21 AND tgfoid = 'dbos.atomic_project_metadata()'::regprocedure) AS projections FROM dbos.atomic_guard_protocol WHERE singleton",
	);
	if (
		validated.rows.length !== 1 ||
		validated.rows[0].fingerprint !== fingerprint ||
		validated.rows[0].triggers !== 2 ||
		validated.rows[0].projections !== 1
	)
		throw new Error("Atomic database ownership guard schema is incompatible or incomplete");
	return true;
}

const guardSql = `
CREATE TABLE IF NOT EXISTS dbos.atomic_owner_generation (
 root text PRIMARY KEY, owner text, generation bigint,
 terminal boolean NOT NULL DEFAULT false, claim text, claimant text, protocol integer NOT NULL DEFAULT 1 CHECK(protocol = 1)
);
CREATE TABLE IF NOT EXISTS dbos.atomic_guard_rows (workflow_uuid text PRIMARY KEY, root text NOT NULL);
CREATE OR REPLACE FUNCTION dbos.atomic_metadata(value text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE decoded jsonb;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 BEGIN decoded := value::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
 IF decoded->>'__dbos_serializer' = 'superjson' THEN decoded := decoded->'json'; END IF;
 IF decoded->>'__atomicDurableMetadata' IS DISTINCT FROM 'true' OR decoded->>'version' IS DISTINCT FROM '3' THEN RETURN NULL; END IF;
 RETURN decoded->'metadata';
END $$;
CREATE OR REPLACE FUNCTION dbos.atomic_guard_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
 row_value jsonb; id text; root_id text; authority jsonb; state dbos.atomic_owner_generation%ROWTYPE;
 meta jsonb; prior jsonb; prior_generation bigint; next_generation bigint; absorbing boolean;
 allowed boolean; cap_owner text; cap_generation bigint; claim_token text;
BEGIN
 row_value := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 id := row_value->>'workflow_uuid';
 root_id := split_part(id, ':checkpoint:', 1);
 IF TG_OP = 'UPDATE' AND to_jsonb(OLD)->>'workflow_uuid' IS DISTINCT FROM id AND (
  EXISTS(SELECT 1 FROM dbos.atomic_guard_rows WHERE workflow_uuid = to_jsonb(OLD)->>'workflow_uuid') OR
  (TG_TABLE_NAME = 'workflow_status' AND to_jsonb(OLD)->>'name' IN ('atomicWorkflowHandle','atomicWorkflowCheckpoint')) OR
  (TG_TABLE_NAME = 'operation_outputs' AND EXISTS(SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid = to_jsonb(OLD)->>'workflow_uuid' AND name IN ('atomicWorkflowHandle','atomicWorkflowCheckpoint')))
 ) THEN
  IF NULLIF(current_setting('atomic.row_authority',true),'') IS NULL OR current_setting('atomic.row_authority',true) = 'null' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Atomic workflow identities are immutable';
 END IF;
 IF TG_TABLE_NAME = 'workflow_status' AND NOT (
  COALESCE(row_value->>'name' IN ('atomicWorkflowHandle','atomicWorkflowCheckpoint'), false) OR
  COALESCE(to_jsonb(OLD)->>'name' IN ('atomicWorkflowHandle','atomicWorkflowCheckpoint'), false) OR
  EXISTS(SELECT 1 FROM dbos.atomic_guard_rows WHERE workflow_uuid = id)
 ) THEN
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 authority := NULLIF(current_setting('atomic.row_authority', true), '')::jsonb;
 IF TG_TABLE_NAME = 'operation_outputs' AND NOT EXISTS (
  SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid = id AND name IN ('atomicWorkflowHandle','atomicWorkflowCheckpoint')
 ) AND NOT EXISTS (SELECT 1 FROM dbos.atomic_guard_rows WHERE workflow_uuid = id) THEN
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 INSERT INTO dbos.atomic_guard_rows VALUES(id, root_id) ON CONFLICT DO NOTHING;
 INSERT INTO dbos.atomic_guard_rows SELECT workflow_uuid, root_id FROM dbos.workflow_status
  WHERE workflow_uuid = root_id AND name = 'atomicWorkflowHandle' ON CONFLICT DO NOTHING;
 INSERT INTO dbos.atomic_owner_generation(root) VALUES(root_id)
  ON CONFLICT(root) DO UPDATE SET root = EXCLUDED.root RETURNING * INTO state;
 IF state.owner IS NULL THEN
  IF TG_TABLE_NAME <> 'workflow_status' OR TG_OP = 'DELETE' OR row_value->>'status' <> 'SUCCESS'
   OR id NOT LIKE root_id || ':checkpoint:__atomic_metadata:%'
   OR authority->>'root' IS DISTINCT FROM root_id OR authority->>'enroll' IS DISTINCT FROM 'true' THEN
   IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  meta := dbos.atomic_metadata(row_value->>'output');
  IF meta IS NULL OR meta->>'workflowId' IS DISTINCT FROM root_id THEN
   RAISE EXCEPTION 'Atomic metadata encoding is unavailable for enrollment';
  END IF;
  SELECT candidate.metadata, candidate.generation INTO prior, prior_generation FROM (
   SELECT dbos.atomic_metadata(output) AS metadata,
    split_part(substring(workflow_uuid FROM length(root_id) + 13), ':', 2)::bigint AS generation
   FROM dbos.workflow_status
   WHERE workflow_uuid LIKE root_id || ':checkpoint:__atomic_metadata:%' AND status = 'SUCCESS'
  ) candidate WHERE candidate.metadata IS NOT NULL
  ORDER BY COALESCE(candidate.metadata->>'status' IN ('completed', 'cancelled') OR
   (candidate.metadata->>'status' IN ('failed','blocked') AND candidate.metadata->>'resumable' = 'false'), false) DESC,
   candidate.generation DESC LIMIT 1;
  IF prior_generation IS DISTINCT FROM (authority->>'generation')::bigint
   OR prior->>'ownerExecutorId' IS DISTINCT FROM authority->>'owner' THEN
   RAISE EXCEPTION 'Atomic ownership generation changed before enrollment';
  END IF;
 ELSE
  IF authority->>'root' IS DISTINCT FROM root_id THEN RETURN NULL; END IF;
  cap_owner := authority->>'owner'; cap_generation := (authority->>'generation')::bigint;
  allowed := cap_owner = state.owner AND cap_generation = state.generation AND (
   authority->>'actor' = state.owner OR
   (authority->>'claim' = state.claim AND authority->>'actor' = state.claimant) OR
   (authority->>'claim' IS NOT NULL AND authority->>'checkpoint' = id));
  IF NOT COALESCE(allowed, false) THEN RAISE EXCEPTION 'Atomic ownership generation changed; stale database writes are refused'; END IF;
 END IF;
 IF TG_TABLE_NAME = 'workflow_status' AND TG_OP = 'UPDATE' THEN
  IF OLD.status = 'SUCCESS' AND OLD.name = 'atomicWorkflowCheckpoint' THEN
   IF NEW.output IS DISTINCT FROM OLD.output OR NEW.status <> 'SUCCESS' THEN RAISE EXCEPTION 'Completed Atomic checkpoints are immutable'; END IF;
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'workflow_status' AND TG_OP <> 'DELETE' AND row_value->>'status' = 'SUCCESS'
  AND id LIKE root_id || ':checkpoint:__atomic_metadata:%' THEN
  meta := dbos.atomic_metadata(row_value->>'output');
  IF meta IS NULL OR meta->>'workflowId' IS DISTINCT FROM root_id OR meta->>'ownerExecutorId' IS DISTINCT FROM authority->>'actor' THEN RAISE EXCEPTION 'Atomic metadata encoding or owner is unavailable'; END IF;
  next_generation := split_part(substring(id FROM length(root_id) + 13), ':', 2)::bigint;
  absorbing := COALESCE(meta->>'status' IN ('completed', 'cancelled') OR
   (meta->>'status' IN ('failed','blocked') AND meta->>'resumable' = 'false'), false);
  claim_token := meta->>'transitionClaimId';
  IF state.root IS NOT NULL AND (next_generation < state.generation OR (state.terminal AND NOT absorbing)) THEN
   RAISE EXCEPTION 'Atomic terminal or newer generation cannot be overwritten';
  END IF;
  IF state.owner IS NOT NULL AND authority->>'actor' <> state.owner THEN
   IF id NOT LIKE '%:claim' OR next_generation <> state.generation + 1 OR claim_token IS DISTINCT FROM authority->>'claim' OR meta->>'ownerExecutorId' IS DISTINCT FROM authority->>'actor' THEN
    RAISE EXCEPTION 'Atomic ownership transfer requires an exact generation claim';
   END IF;
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE OR REPLACE FUNCTION dbos.atomic_project_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE root_id text; meta jsonb; authority jsonb; state dbos.atomic_owner_generation%ROWTYPE; projected_generation bigint; absorbing boolean;
BEGIN
 IF NEW.name <> 'atomicWorkflowCheckpoint' OR NEW.status <> 'SUCCESS' THEN RETURN NEW; END IF;
 root_id := split_part(NEW.workflow_uuid, ':checkpoint:', 1);
 IF NEW.workflow_uuid NOT LIKE root_id || ':checkpoint:__atomic_metadata:%' THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' THEN IF OLD.status = 'SUCCESS' THEN RETURN NEW; END IF; END IF;
 authority := NULLIF(current_setting('atomic.row_authority', true), '')::jsonb;
 SELECT * INTO state FROM dbos.atomic_owner_generation WHERE root = root_id FOR UPDATE;
 IF state.owner IS NULL AND authority->>'enroll' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
 meta := dbos.atomic_metadata(NEW.output);
 projected_generation := split_part(substring(NEW.workflow_uuid FROM length(root_id) + 13), ':', 2)::bigint;
 absorbing := COALESCE(meta->>'status' IN ('completed','cancelled') OR (meta->>'status' IN ('failed','blocked') AND meta->>'resumable' = 'false'), false);
 UPDATE dbos.atomic_owner_generation SET owner = meta->>'ownerExecutorId', generation = projected_generation,
  terminal = absorbing, claim = CASE WHEN NEW.workflow_uuid LIKE '%:claim' THEN meta->>'transitionClaimId' END,
  claimant = CASE WHEN NEW.workflow_uuid LIKE '%:claim' THEN authority->>'actor' END WHERE root = root_id;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'dbos.workflow_status'::regclass AND tgname = 'atomic_generation_guard') THEN
  CREATE TRIGGER atomic_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON dbos.workflow_status
   FOR EACH ROW EXECUTE FUNCTION dbos.atomic_guard_row();
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'dbos.operation_outputs'::regclass AND tgname = 'atomic_generation_guard') THEN
  CREATE TRIGGER atomic_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON dbos.operation_outputs
   FOR EACH ROW EXECUTE FUNCTION dbos.atomic_guard_row();
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'dbos.workflow_status'::regclass AND tgname = 'atomic_generation_projection') THEN
  CREATE TRIGGER atomic_generation_projection AFTER INSERT OR UPDATE ON dbos.workflow_status
   FOR EACH ROW EXECUTE FUNCTION dbos.atomic_project_metadata();
 END IF;
END $$;
`;

const fingerprint = createHash("sha256").update(guardSql).digest("hex");
