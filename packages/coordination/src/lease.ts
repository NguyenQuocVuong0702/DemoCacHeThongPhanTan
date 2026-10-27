import type { Pool, PoolClient } from "pg";

export type LeaseToken = { nodeId: string; instanceId: string; epoch: string };
export type AssignmentAuthority = LeaseToken & { assertCurrent(): void };
export class AuthorityLostError extends Error {
  constructor() { super("No valid assignment leader or stale fencing token"); }
}

export async function acquireOrRenewLease(pool: Pool, nodeId: string, instanceId: string, ttlMs = 8000): Promise<LeaseToken | undefined> {
  const result = await pool.query<{ epoch: string }>(
    `UPDATE assignment_authority SET
       epoch=CASE WHEN holder_node_id=$1 AND holder_instance_id=$2 AND lease_until>clock_timestamp()
                  THEN epoch ELSE epoch+1 END,
       holder_node_id=$1, holder_instance_id=$2,
       lease_until=clock_timestamp()+($3::int * interval '1 millisecond')
     WHERE singleton=true AND (lease_until<=clock_timestamp() OR holder_node_id IS NULL
       OR (holder_node_id=$1 AND holder_instance_id=$2))
     RETURNING epoch::text`, [nodeId, instanceId, ttlMs],
  );
  return result.rows[0] ? { nodeId, instanceId, epoch: result.rows[0].epoch } : undefined;
}

export async function releaseLease(pool: Pool, token: LeaseToken): Promise<void> {
  await pool.query(
    `UPDATE assignment_authority SET holder_node_id=NULL,holder_instance_id=NULL,
       epoch=epoch+1,lease_until=clock_timestamp()
     WHERE singleton=true AND holder_node_id=$1 AND holder_instance_id=$2 AND epoch=$3::bigint`,
    [token.nodeId, token.instanceId, token.epoch],
  );
}

export async function setAuthorityContext(client: PoolClient, token: LeaseToken): Promise<void> {
  await client.query(
    `SELECT set_config('smartedge.coordinator_node',$1,true),
       set_config('smartedge.coordinator_instance',$2,true),set_config('smartedge.coordinator_epoch',$3,true)`,
    [token.nodeId, token.instanceId, token.epoch],
  );
}

export async function lockAndValidateAuthority(client: PoolClient, token: LeaseToken): Promise<void> {
  // Lock the singleton only AFTER sensor locks. A task waiting on processing
  // must not prevent a new leader taking the lease and fencing that old task.
  const result = await client.query(
    `SELECT 1 FROM assignment_authority WHERE singleton=true AND holder_node_id=$1
       AND holder_instance_id=$2 AND epoch=$3::bigint AND lease_until>clock_timestamp() FOR UPDATE`,
    [token.nodeId, token.instanceId, token.epoch],
  );
  if (!result.rowCount) throw new AuthorityLostError();
}
