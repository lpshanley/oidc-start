-- Run periodically on the primary. Allow a margin for clock differences.
UPDATE oidc_refresh SET sealed_result = NULL
WHERE sealed_result IS NOT NULL AND completed_at < now() - interval '1 minute';
DELETE FROM oidc_refresh
WHERE reserved_until < extract(epoch FROM now() - interval '1 day');
DELETE FROM oidc_revocation WHERE kind IN ('provider', 'session')
AND value < extract(epoch FROM now() - interval '1 day');
