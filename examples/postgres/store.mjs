import { RefreshNotDispatched } from "@lpshanley/oidc-start-core/provider";

// Requires a direct or session-pooled pg.Pool with finite statement timeouts.
export function createPostgresStore(pool, namespace) {
  if (!namespace) throw new Error("A store namespace is required");
  const scoped = s => [namespace, s.issuer, s.clientId];
  async function mutate(scope, work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Short mutations share one scope lock, so registration and logout have
      // a single order. There are no provider calls under this transaction.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(scoped(scope))]);
      await work(client);
      await client.query("COMMIT");
      client.release();
    } catch (error) {
      try { await client.query("ROLLBACK"); } finally { client.release(true); }
      throw error;
    }
  }
  const registry = {
    register: s => mutate(s, client => client.query(`
      INSERT INTO oidc_session(namespace,issuer,client_id,sid,subject,idp_sid,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [...scoped(s), s.sid, s.sub, s.idpSid ?? null, s.expiresAt])),
    async isActive(s) {
      const result = await pool.query(`SELECT 1 FROM oidc_session
        WHERE namespace=$1 AND issuer=$2 AND client_id=$3 AND sid=$4
        AND expires_at > extract(epoch FROM statement_timestamp())`, [...scoped(s), s.sid]);
      return result.rowCount > 0;
    },
    end: s => mutate(s, client => client.query(`DELETE FROM oidc_session
      WHERE namespace=$1 AND issuer=$2 AND client_id=$3 AND sid=$4`, [...scoped(s), s.sid])),
    endAll: s => mutate(s, client => client.query(`DELETE FROM oidc_session
      WHERE namespace=$1 AND issuer=$2 AND client_id=$3 AND subject=$4`, [...scoped(s), s.sub])),
    applyLogout: event => mutate(event, async client => {
      const receipt = await client.query(`INSERT INTO oidc_logout_receipt(namespace,issuer,client_id,jti,expires_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING jti`, [...scoped(event), event.jti, event.expiresAt]);
      if (!receipt.rowCount) return;
      await client.query(`DELETE FROM oidc_session WHERE namespace=$1 AND issuer=$2 AND client_id=$3
        AND ($4::text IS NULL OR idp_sid=$4) AND ($5::text IS NULL OR subject=$5)`,
        [...scoped(event), event.idpSid ?? null, event.sub ?? null]);
    }),
  };

  const refreshCoordinator = {
    async run({ key, until, reuseMs }, produce) {
      const client = await pool.connect();
      let reserved = false;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [JSON.stringify([namespace, key])]);
        const claim = await client.query(`INSERT INTO oidc_refresh(namespace,key,reserved_until)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [namespace, key, until]);
        reserved = claim.rowCount > 0;
        let result;
        if (!reserved) {
          const previous = await client.query(`SELECT sealed_result FROM oidc_refresh WHERE namespace=$1 AND key=$2
            AND completed_at > clock_timestamp() - $3 * interval '1 millisecond'`, [namespace, key, reuseMs]);
          result = previous.rows[0]?.sealed_result
            ? { status: "ready", sealedResult: previous.rows[0].sealed_result }
            : { status: "reauth_required" };
        } else {
          // The committed reservation survives a lost response or a crashed worker.
          let sealedResult;
          try { sealedResult = await produce(); }
          catch (error) {
            if (error instanceof RefreshNotDispatched) {
              await client.query("DELETE FROM oidc_refresh WHERE namespace=$1 AND key=$2", [namespace, key]);
              throw error;
            }
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [JSON.stringify([namespace, key])]);
            client.release();
            return { status: "reauth_required" };
          }
          await client.query(`UPDATE oidc_refresh SET sealed_result=$3,completed_at=clock_timestamp()
            WHERE namespace=$1 AND key=$2`, [namespace, key, sealedResult]);
          result = { status: "ready", sealedResult };
        }
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [JSON.stringify([namespace, key])]);
        client.release();
        return result;
      } catch (error) {
        client.release(true);
        if (!reserved && (error.code === "57014" || error.code === "55P03")) return { status: "busy" };
        throw error;
      }
    },
  };
  return { registry, refreshCoordinator };
}
