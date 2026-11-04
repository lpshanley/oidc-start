CREATE TABLE oidc_revocation (
  namespace text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('session', 'provider', 'subject')),
  id text NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY (namespace, kind, id)
);

CREATE TABLE oidc_refresh (
  namespace text NOT NULL,
  key text NOT NULL,
  reserved_until bigint NOT NULL,
  completed_at timestamptz,
  sealed_result text,
  PRIMARY KEY (namespace, key)
);
