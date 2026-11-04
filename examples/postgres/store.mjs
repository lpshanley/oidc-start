// Pass one pg.Pool connected to the primary and a namespace unique to this app,
// issuer and client. Session lifetime and revocation arguments use epoch seconds.
export function createPostgresStore(pool, namespace) {
	if (!namespace) throw new Error("A store namespace is required");

	async function record(kind, id, value) {
		await pool.query(`
			INSERT INTO oidc_revocation (namespace, kind, id, value) VALUES ($1, $2, $3, $4)
			ON CONFLICT (namespace, kind, id) DO UPDATE
			SET value = GREATEST(oidc_revocation.value, EXCLUDED.value)
		`, [namespace, kind, id, value]);
	}

	const revocations = {
		async isRevoked({ sid, idpSid, sub, issuedAt }) {
			const result = await pool.query(`
				SELECT 1 FROM oidc_revocation WHERE namespace = $1 AND (
					(kind = 'subject' AND id = $4 AND value >= $5) OR
					(((kind = 'session' AND id = $2) OR (kind = 'provider' AND id = $3))
						AND value >= floor(extract(epoch FROM statement_timestamp())))
				) LIMIT 1
			`, [namespace, sid, idpSid ?? null, sub, issuedAt]);
			return result.rowCount > 0;
		},
		revoke: (sid, until) => record("session", sid, until),
		revokeIdpSession: (sid, until) => record("provider", sid, until),
		revokeAllFor: (sub, cutoff) => record("subject", sub, cutoff),
	};

	async function readOrProduce(client, { key, until, reuseMs }, produce) {
		const claim = await client.query(`
			INSERT INTO oidc_refresh (namespace, key, reserved_until) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING
		`, [namespace, key, until]);
		if (!claim.rowCount) {
			const previous = await client.query(`
				SELECT sealed_result FROM oidc_refresh WHERE namespace = $1 AND key = $2
					AND completed_at > clock_timestamp() - $3 * interval '1 millisecond'
			`, [namespace, key, reuseMs]);
			return previous.rows[0]?.sealed_result ?? null;
		}
		// Commit the reservation before dispatch. A crash can lose the result,
		// but another worker cannot rotate this token again.
		const sealed = await produce();
		await client.query(`
			UPDATE oidc_refresh SET sealed_result = $3, completed_at = clock_timestamp()
			WHERE namespace = $1 AND key = $2
		`, [namespace, key, sealed]);
		return sealed;
	}

	const refreshCoordinator = {
		async run(request, produce) {
			// Requires a direct or session-pooled connection and a statement timeout.
			const lock = [namespace + ":" + request.key];
			const client = await pool.connect();
			try {
				await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", lock);
				const result = await readOrProduce(client, request, produce);
				await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", lock);
				client.release();
				return result;
			} catch (error) {
				// Closing the connection releases the lock even on ambiguous errors.
				client.release(true);
				throw error;
			}
		},
	};
	return { revocations, refreshCoordinator };
}
