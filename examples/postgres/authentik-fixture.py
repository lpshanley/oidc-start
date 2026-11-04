# Run only inside the disposable Authentik instance used by authentik-check.mjs.
from authentik.core.models import Application, User
from authentik.crypto.models import CertificateKeyPair
from authentik.flows.models import Flow
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping

provider, _ = OAuth2Provider.objects.update_or_create(
    name="oidc-start-050",
    defaults={
        "client_id": "oidc-start-050", "client_secret": "oidc-fixture-only",
        "grant_types": ["authorization_code", "refresh_token"],
        "authorization_flow": Flow.objects.get(slug="default-provider-authorization-implicit-consent"),
        "invalidation_flow": Flow.objects.get(slug="default-provider-invalidation-flow"),
        "signing_key": CertificateKeyPair.objects.get(name="authentik Self-signed Certificate"),
        "_redirect_uris": [
            {"matching_mode": "strict", "url": "http://127.0.0.1:19872/callback"},
            {"matching_mode": "strict", "url": "http://127.0.0.1:19872/"},
        ],
        "logout_uri": "http://host.docker.internal:19872/backchannel-logout",
        "logout_method": "backchannel", "access_token_validity": "seconds=25",
        "refresh_token_threshold": "seconds=0",
    },
)
provider.property_mappings.set(ScopeMapping.objects.filter(scope_name__in=["openid", "profile", "email", "offline_access"]))
Application.objects.update_or_create(slug="oidc-start-050", defaults={"name": "OIDC 0.5 fixture", "provider": provider})
user, _ = User.objects.get_or_create(username="oidc-user", defaults={"name": "Round Trip Tester", "email": "tester@example.test"})
user.set_password("oidc-fixture-only")
user.save()
print("Disposable Authentik fixture ready")
