using System.Net;
using System.Net.Http.Json;
using Lunos.Api.Data;
using Lunos.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions; // RemoveAll<T>() lives here
using Xunit;

namespace Lunos.Api.Tests;

public class FakeUnreachableHealthChecker : IDatabaseHealthChecker
{
    public Task<bool> CanConnectAsync(CancellationToken cancellationToken = default) => Task.FromResult(false);
}

public class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>, IDisposable
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");
    private readonly WebApplicationFactory<Program> _factory;

    public HealthEndpointTests(WebApplicationFactory<Program> factory)
    {
        _connection.Open();
        _factory = factory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Testing"); // skips Program.cs's own startup migration — see the comment there
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<LunosDbContext>>();
                services.AddDbContext<LunosDbContext>(options => options.UseSqlite(_connection));
            });
        });

        // Migrate through the app's own DI container — not a second throwaway provider built via
        // services.BuildServiceProvider() inside ConfigureServices, which would construct a distinct
        // LunosDbContext instance from the one the running app actually resolves and use.
        using var scope = _factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<LunosDbContext>().Database.Migrate();
    }

    [Fact]
    public async Task Health_WhenDbReachable_Returns200()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Health_WhenDbUnreachable_ReturnsNon200_NotA200WithFalseFlag()
    {
        var client = _factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IDatabaseHealthChecker>();
                services.AddScoped<IDatabaseHealthChecker, FakeUnreachableHealthChecker>();
            });
        }).CreateClient();

        var response = await client.GetAsync("/health");

        // Assert.NotEqual(OK) alone would also pass if the handler threw and the global exception
        // handler returned 500 — that doesn't verify the AC (a deliberate non-200, not an accident).
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("dbConnected", body);
    }

    public void Dispose() => _connection.Dispose();
}
