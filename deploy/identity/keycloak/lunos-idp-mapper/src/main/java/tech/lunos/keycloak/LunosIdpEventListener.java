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
    if (event.getType() != EventType.LOGIN) return;
    RealmModel realm = session.realms().getRealm(event.getRealmId());
    // LOGIN is sent in the request that finished the authentication, before Keycloak drops the
    // authentication session's SSO marker, so the session tells a cookie sign-in from a real one.
    AuthenticationSessionModel authSession = session.getContext().getAuthenticationSession();
    // On the consent path (every device sign-in, and clients that ask for consent) Keycloak sends LOGIN
    // before it attaches the user session, so the event has no session id yet; the session it attaches
    // is the one named after the authentication session's root.
    String sessionId = event.getSessionId() != null ? event.getSessionId()
        : authSession != null ? authSession.getParentSession().getId() : null;
    if (sessionId == null) return;

    // Without the authentication session, the sign-in counts as a real one: losing an org value is
    // safer than keeping a stale one.
    boolean sso = authSession != null && AuthenticatorUtil.isSSOAuthentication(authSession);
    // The broker puts the provider in this authentication's notes; Keycloak only copies them onto the
    // user session, so a provider found here was used by this sign-in, not an earlier one.
    String brokered = authSession != null
        ? authSession.getUserSessionNotes().get(Details.IDENTITY_PROVIDER)
        : event.getDetails() == null ? null : event.getDetails().get(Details.IDENTITY_PROVIDER);
    String alias = LunosIdp.aliasAfterLogin(sso, brokered);
    LOG.debugf("lunos_idp: session %s sso=%s brokered=%s -> %s", sessionId, sso, brokered, alias);
    if (alias == null) return;

    // A session not attached yet gets the note when Keycloak copies this sign-in's notes onto it.
    if (authSession != null) authSession.setUserSessionNote(NOTE, alias);
    UserSessionModel online = session.sessions().getUserSession(realm, sessionId);
    if (online != null) online.setNote(NOTE, alias);
    // An offline session copies the online session's notes only when it is first created; when a later
    // sign-in with offline_access reuses it, its refresh tokens would keep the earlier value.
    UserSessionModel offline = session.sessions().getOfflineUserSession(realm, sessionId);
    if (offline != null) offline.setNote(NOTE, alias);
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
