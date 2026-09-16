using Lunos.Api.Services;

namespace Lunos.Api.Endpoints;

public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        // Unversioned and unprefixed on purpose: deploy.ps1's smoke test hits /health directly, not /api/v1/health.
        app.MapGet("/health", async (IDatabaseHealthChecker healthChecker) =>
        {
            var dbConnected = await healthChecker.CanConnectAsync();
            if (!dbConnected)
            {
                // Non-200, not a 200 body with dbConnected:false — deploy.ps1's smoke test only checks status code.
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }

            // lastIngestionRunUtc is added here in Phase 2, once there's a job to report on.
            return Results.Ok(new { status = "ok", dbConnected = true });
        });
    }
}
