// XCOD-185: the lunos_idp resolution rule (lunoshq docs/enforce-sso.md, "The contract").
package tech.lunos.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class LunosIdpTest {
  @Test
  void noBrokerIsLunosOwnSignIn() {
    assertEquals("lunos", LunosIdp.resolve(null, null));
    assertEquals("lunos", LunosIdp.resolve("", "org:acme:entra"));
  }

  @Test
  void socialProviderIsItsAlias() {
    assertEquals("github", LunosIdp.resolve("github", null));
    assertEquals("google", LunosIdp.resolve("google", ""));
  }

  @Test
  void organisationProviderIsItsConfiguredValue() {
    assertEquals("org:acme:entra", LunosIdp.resolve("acme-entra", "org:acme:entra"));
    assertEquals("org:axsion-eu:okta.main", LunosIdp.resolve("x", "org:axsion-eu:okta.main"));
  }

  @Test
  void anInvalidConfiguredValueFallsBackToTheAlias() {
    for (String bad : new String[] {"org:ACME:entra", "org:acme:", "org::entra", "org:acme:-x", "org:acme:a b",
        "org:acme:entra\n", "lunos", "google", "org:acme:" + "x".repeat(64), " org:acme:entra"}) {
      assertEquals("acme-entra", LunosIdp.resolve("acme-entra", bad), bad);
    }
  }

  @Test
  void aCookieSignInKeepsTheSessionsProvider() {
    assertEquals("acme-entra", LunosIdp.aliasAfterLogin(true, null, "acme-entra"));
    assertNull(LunosIdp.aliasAfterLogin(true, null, null));
  }

  @Test
  void aPasswordSignInClearsTheSessionsProvider() {
    assertNull(LunosIdp.aliasAfterLogin(false, null, "acme-entra"));
    assertNull(LunosIdp.aliasAfterLogin(false, "", "acme-entra"));
  }

  @Test
  void aBrokeredSignInRecordsItsProvider() {
    assertEquals("acme-entra", LunosIdp.aliasAfterLogin(false, "acme-entra", null));
    assertEquals("acme-entra", LunosIdp.aliasAfterLogin(false, "acme-entra", "github"));
  }

  @Test
  void anAliasThatLooksLikeAnOrgValueIsNeverTakenAsOne() {
    // Only the config attribute may carry the org form, so ':' in a fallback alias is replaced.
    assertEquals("org-acme-entra", LunosIdp.resolve("org-acme-entra", null));
    assertEquals("org-acme-entra", LunosIdp.resolve("org:acme:entra", null));
    assertEquals("org:acme:entra", LunosIdp.resolve("org:acme:entra", "org:acme:entra"));
  }
}
