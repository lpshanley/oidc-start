CREATE TABLE oidc_session (
  namespace text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  sid text NOT NULL,
  subject text NOT NULL,
  idp_sid text,
  expires_at bigint NOT NULL,
  PRIMARY KEY (namespace, issuer, client_id, sid)
);
CREATE INDEX oidc_session_subject ON oidc_session (namespace, issuer, client_id, subject);
CREATE INDEX oidc_session_provider ON oidc_session (namespace, issuer, client_id, idp_sid);
CREATE TABLE oidc_logout_receipt (
  namespace text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  jti text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (namespace, issuer, client_id, jti)
);
CREATE TABLE oidc_refresh (
  namespace text NOT NULL,
  key text NOT NULL,
  reserved_until bigint NOT NULL,
  completed_at timestamptz,
  sealed_result text,
  PRIMARY KEY (namespace, key)
);
