// XCOD-185: which identity provider a sign-in went through, as the lunos_idp claim names it.
// The console's enforce-SSO compares it with an organisation's rule (lunoshq docs/enforce-sso.md),
// so the org form may only come from the identity provider's own config, which only realm admins
// and the console's admin service account can write; an alias or anything malformed can never
// produce it (an alias containing ':' has them replaced by '-', so it cannot imitate the org form).
package tech.lunos.keycloak;

import java.util.regex.Pattern;

public final class LunosIdp {
  public static final String CLAIM = "lunos_idp";
  /** Identity provider config attribute holding org:<org id>:<connection>. */
  public static final String CONFIG_KEY = "lunosIdp";
  /** The realm's own credentials (password, passkey): no brokered provider. */
  public static final String OWN = "lunos";

  private static final Pattern ORG = Pattern.compile("^org:[a-z0-9-]+:[a-z0-9][a-z0-9_.-]{0,62}$");

  private LunosIdp() {}

  /**
   * @param alias the brokered identity provider's alias from the user session, or null/empty when
   *     the user signed in with the realm's own credentials
   * @param configured that provider's lunosIdp config attribute, or null
   */
  public static String resolve(String alias, String configured) {
    if (alias == null || alias.isEmpty()) return OWN;
    if (configured != null && ORG.matcher(configured).matches()) return configured;
    return alias.replace(':', '-');
  }

  /**
   * The identity provider alias a user session's tokens should name after a sign-in to it. Keycloak's
   * own "identity_provider" note survives a later password re-authentication into the same session,
   * so the claim follows the latest authentication instead: a cookie (SSO) sign-in to another client
   * authenticates nothing and keeps the value; any other sign-in replaces it.
   *
   * @param sso the sign-in was by the session cookie alone
   * @param brokeredAlias the identity provider this sign-in went through, or null/empty for the realm's
   *     own credentials
   * @param current the alias recorded for the session so far, or null
   * @return the alias to record, or null for the realm's own credentials
   */
  public static String aliasAfterLogin(boolean sso, String brokeredAlias, String current) {
    if (sso) return current;
    return brokeredAlias == null || brokeredAlias.isEmpty() ? null : brokeredAlias;
  }
}
