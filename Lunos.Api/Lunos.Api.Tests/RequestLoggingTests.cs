using Lunos.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Serilog.Sinks.TestCorrelator;
using Xunit;

namespace Lunos.Api.Tests;

public class RequestLoggingTests : IClassFixture<WebApplicationFactory<Program>>, IDisposable
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");
    private readonly WebApplicationFactory<Program> _factory;

    public RequestLoggingTests(WebApplicationFactory<Program> factory)
    {
        _connection.Open();
        _factory = factory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<LunosDbContext>>();
                services.AddDbContext<LunosDbContext>(options => options.UseSqlite(_connection));
            });
        });

        using var scope = _factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<LunosDbContext>().Database.Migrate();

        // TestServer defaults to isolating client and server ExecutionContext (since ASP.NET Core 3.0),
        // which breaks TestCorrelator's AsyncLocal-based context correlation across the client/server boundary.
        _factory.Server.PreserveExecutionContext = true;
    }

    [Fact]
    public async Task Request_EmitsLogEventWithPathAndStatusCode()
    {
        using var context = TestCorrelator.CreateContext();
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/health");

        var events = TestCorrelator.GetLogEventsFromCurrentContext();
        Assert.Contains(events, e =>
            e.MessageTemplate.Text.Contains("{RequestPath}") &&
            e.Properties.TryGetValue("RequestPath", out var path) &&
            path.ToString().Contains("/health") &&
            e.Properties.ContainsKey("StatusCode") &&
            e.Properties.ContainsKey("Elapsed"));
    }

    public void Dispose() => _connection.Dispose();
}
