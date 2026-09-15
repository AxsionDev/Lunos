using System.Net;
using System.Net.Http.Json;
using Lunos.Api.Dtos;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Lunos.Api.Tests;

public class ExceptionHandlingTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task UnhandledException_ReturnsStandardErrorEnvelope()
    {
        var client = factory.WithWebHostBuilder(builder => builder.UseEnvironment("Testing")).CreateClient();

        var response = await client.GetAsync("/__throw");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.Equal("internal_error", body!.Error.Code);
    }
}
