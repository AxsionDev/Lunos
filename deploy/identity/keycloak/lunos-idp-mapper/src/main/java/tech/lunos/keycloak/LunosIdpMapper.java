// XCOD-185: puts lunos_idp in Lunos's tokens (ID, access, userinfo). It names the identity provider of
// the user session's latest authentication, which LunosIdpEventListener records as a user-session note;
// the note lives with the session, so a refreshed token, or a cookie sign-in to another client, carries
// the value of that authentication, as the contract asks.
package tech.lunos.keycloak;

import java.util.ArrayList;
import java.util.List;
import org.keycloak.models.ClientSessionContext;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.ProtocolMapperModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.protocol.oidc.mappers.AbstractOIDCProtocolMapper;
import org.keycloak.protocol.oidc.mappers.OIDCAccessTokenMapper;
import org.keycloak.protocol.oidc.mappers.OIDCAttributeMapperHelper;
import org.keycloak.protocol.oidc.mappers.OIDCIDTokenMapper;
import org.keycloak.protocol.oidc.mappers.TokenIntrospectionTokenMapper;
import org.keycloak.protocol.oidc.mappers.UserInfoTokenMapper;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.representations.IDToken;

public class LunosIdpMapper extends AbstractOIDCProtocolMapper
    implements OIDCAccessTokenMapper, OIDCIDTokenMapper, UserInfoTokenMapper,
        TokenIntrospectionTokenMapper {

  public static final String PROVIDER_ID = "lunos-idp-mapper";
  private static final List<ProviderConfigProperty> CONFIG = new ArrayList<>();

  static {
    OIDCAttributeMapperHelper.addIncludeInTokensConfig(CONFIG, LunosIdpMapper.class);
  }

  @Override
  public String getId() {
    return PROVIDER_ID;
  }

  @Override
  public String getDisplayCategory() {
    return TOKEN_MAPPER_CATEGORY;
  }

  @Override
  public String getDisplayType() {
    return "Lunos identity provider (lunos_idp)";
  }

  @Override
  public String getHelpText() {
    return "Adds lunos_idp: 'lunos' for the realm's own credentials, the identity provider's lunosIdp "
        + "attribute (org:<org>:<connection>) for an organisation's provider, else the provider's alias.";
  }

  @Override
  public List<ProviderConfigProperty> getConfigProperties() {
    return CONFIG;
  }

  @Override
  protected void setClaim(IDToken token, ProtocolMapperModel mappingModel, UserSessionModel userSession,
      KeycloakSession keycloakSession, ClientSessionContext clientSessionCtx) {
    // Recomputed from the provider's current config on every issuance and refresh, so an admin changing
    // lunosIdp or deleting the provider changes the value, falling back safely to the alias.
    String alias = userSession.getNote(LunosIdpEventListener.NOTE);
    String configured = null;
    if (alias != null && !alias.isEmpty()) {
      IdentityProviderModel idp = keycloakSession.identityProviders().getByAlias(alias);
      if (idp != null && idp.getConfig() != null) configured = idp.getConfig().get(LunosIdp.CONFIG_KEY);
    }
    token.getOtherClaims().put(LunosIdp.CLAIM, LunosIdp.resolve(alias, configured));
  }
}
