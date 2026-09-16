using System.Linq;
using System.Net.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Lunos.Api.Tests;

public class CorsPolicyTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Preflight_FromAllowedDevOrigin_ReturnsAllowOriginHeader()
    {
        var client = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Development")).CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Options, "/health");
        request.Headers.Add("Origin", "http://localhost:4200");
        request.Headers.Add("Access-Control-Request-Method", "GET");

        var response = await client.SendAsync(request);

        Assert.True(response.Headers.Contains("Access-Control-Allow-Origin"));
        Assert.Equal("http://localhost:4200", response.Headers.GetValues("Access-Control-Allow-Origin").First());
    }

    [Fact]
    public async Task Preflight_FromDisallowedOrigin_DoesNotReturnAllowOriginHeader()
    {
        var client = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Development")).CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Options, "/health");
        request.Headers.Add("Origin", "https://evil.example.com");
        request.Headers.Add("Access-Control-Request-Method", "GET");

        var response = await client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }
}
