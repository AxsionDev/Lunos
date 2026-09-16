using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using Lunos.Api.Data;
using Lunos.Api.Dtos;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions; // RemoveAll<T>() lives here
using Xunit;

namespace Lunos.Api.Tests;

public class ContactEndpointTests : IClassFixture<WebApplicationFactory<Program>>, IDisposable
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");
    private readonly HttpClient _client;
    private readonly WebApplicationFactory<Program> _factory;

    public ContactEndpointTests(WebApplicationFactory<Program> factory)
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

        // Migrate through the app's own DI container, same reasoning as HealthEndpointTests (Task 2):
        // a second provider built via BuildServiceProvider() would migrate a different LunosDbContext
        // instance than the one the running app resolves.
        using (var scope = _factory.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<LunosDbContext>().Database.Migrate();
        }

        _client = _factory.CreateClient();
    }

    [Fact]
    public async Task PostContact_WithValidPayload_Returns201AndPersists()
    {
        var payload = new ContactRequestDto("dev@example.com", "Evaluating for a public-sector pilot.", "ECRIS integration");

        var response = await _client.PostAsJsonAsync("/api/v1/contact", payload);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ContactResponseDto>();
        Assert.NotEqual(Guid.Empty, body!.Id);
    }

    [Fact]
    public async Task PostContact_WithInvalidEmail_Returns400ValidationError()
    {
        var payload = new ContactRequestDto("not-an-email", "Hello", null);

        var response = await _client.PostAsJsonAsync("/api/v1/contact", payload);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.Equal("validation_error", body!.Error.Code);
        Assert.True(body.Error.Fields!.ContainsKey("email"));
    }

    [Fact]
    public async Task PostContact_WithEmptyMessage_Returns400ValidationError()
    {
        var payload = new ContactRequestDto("dev@example.com", "", null);

        var response = await _client.PostAsJsonAsync("/api/v1/contact", payload);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.True(body!.Error.Fields!.ContainsKey("message"));
    }

    [Fact]
    public async Task PostContact_WithEmptyBody_Returns400ValidationErrorEnvelope_NotFrameworkProblemDetails()
    {
        // Guards against the nullability regression this task's Step 1 documents: a non-nullable
        // DTO property would make ASP.NET Core reject this with its own ProblemDetails 400 before
        // ContactValidator runs, which is a different, non-conformant error shape.
        var response = await _client.PostAsJsonAsync("/api/v1/contact", new { });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.Equal("validation_error", body!.Error.Code);
        Assert.True(body.Error.Fields!.ContainsKey("email"));
        Assert.True(body.Error.Fields!.ContainsKey("message"));
    }

    [Fact]
    public async Task PostContact_UsesCamelCaseWireShape_AndPersistsExactFieldValues()
    {
        // Raw JSON with literal lowercase keys pins the wire contract Task 8's ContactApiService
        // depends on — round-tripping through typed DTOs (as the other tests do) would pass even
        // against a PascalCase server, since System.Text.Json defaults to case-insensitive reads.
        var rawRequest = new StringContent(
            """{"email":"dev@example.com","message":"Evaluating for a public-sector pilot.","context":"ECRIS integration"}""",
            System.Text.Encoding.UTF8,
            "application/json");

        var response = await _client.PostAsync("/api/v1/contact", rawRequest);
        var rawBody = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Contains("\"id\"", rawBody);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LunosDbContext>();
        var stored = Assert.Single(db.Contacts.ToList());
        Assert.Equal("dev@example.com", stored.Email);
        Assert.Equal("Evaluating for a public-sector pilot.", stored.Message);
        Assert.Equal("ECRIS integration", stored.Context);
    }

    public void Dispose() => _connection.Dispose();
}
