DELETE FROM oidc_session WHERE expires_at <= extract(epoch FROM statement_timestamp());
DELETE FROM oidc_logout_receipt WHERE expires_at <= extract(epoch FROM statement_timestamp());
DELETE FROM oidc_refresh WHERE reserved_until <= extract(epoch FROM statement_timestamp());
UPDATE oidc_refresh SET sealed_result = NULL WHERE completed_at < clock_timestamp() - interval '10 seconds';
