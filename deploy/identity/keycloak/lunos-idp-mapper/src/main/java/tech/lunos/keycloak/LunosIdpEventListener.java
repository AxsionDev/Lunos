// XCOD-185: records, on every sign-in, which identity provider the user session's latest authentication
// went through, for LunosIdpMapper. Keycloak's own "identity_provider" note can't be used: a password
// re-authentication into a session first opened through an organisation's provider keeps it, so the
// tokens would still claim the organisation's SSO. The realm must list this listener ("lunos-idp") in
// its event listeners; without it the note is never written and every token says "lunos", which
// fails closed (enforce-SSO rejects) rather than open.
package tech.lunos.keycloak;

import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.authentication.AuthenticatorUtil;
import org.keycloak.events.Details;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.sessions.AuthenticationSessionModel;

public class LunosIdpEventListener implements EventListenerProvider, EventListenerProviderFactory {

  public static final String PROVIDER_ID = "lunos-idp";
  /** The user-session note holding the latest authentication's identity provider alias. */
  static final String NOTE = "lunos.idp.alias";

  private static final Logger LOG = Logger.getLogger(LunosIdpEventListener.class);

  private final KeycloakSession session;

  public LunosIdpEventListener() {
    this(null);
  }

  private LunosIdpEventListener(KeycloakSession session) {
    this.session = session;
  }

  @Override
  public void onEvent(Event event) {
    if (event.getType() != EventType.LOGIN || event.getSessionId() == null) return;
    RealmModel realm = session.realms().getRealm(event.getRealmId());
    UserSessionModel userSession = session.sessions().getUserSession(realm, event.getSessionId());
    if (userSession == null) return;

    // LOGIN is sent in the request that finished the authentication, before Keycloak drops the
    // authentication session's SSO marker, so the session tells a cookie sign-in from a real one.
    // Without it, the sign-in counts as a real one: losing an org value is safer than keeping a stale one.
    AuthenticationSessionModel authSession = session.getContext().getAuthenticationSession();
    boolean sso = authSession != null && AuthenticatorUtil.isSSOAuthentication(authSession);
    // The broker puts the provider in this authentication's notes; Keycloak only copies them onto the
    // user session, so a provider found here was used by this sign-in, not an earlier one.
    String brokered = authSession != null
        ? authSession.getUserSessionNotes().get(Details.IDENTITY_PROVIDER)
        : event.getDetails() == null ? null : event.getDetails().get(Details.IDENTITY_PROVIDER);

    String alias = LunosIdp.aliasAfterLogin(sso, brokered, userSession.getNote(NOTE));
    LOG.debugf("lunos_idp: session %s sso=%s brokered=%s -> %s", userSession.getId(), sso, brokered, alias);
    if (alias == null) userSession.removeNote(NOTE);
    else userSession.setNote(NOTE, alias);
  }

  @Override
  public void onEvent(AdminEvent event, boolean includeRepresentation) {}

  @Override
  public EventListenerProvider create(KeycloakSession session) {
    return new LunosIdpEventListener(session);
  }

  @Override
  public String getId() {
    return PROVIDER_ID;
  }

  @Override
  public void init(Config.Scope config) {}

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}
}
