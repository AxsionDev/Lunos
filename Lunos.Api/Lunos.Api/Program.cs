using Lunos.Api.Data;
using Lunos.Api.Dtos;
using Lunos.Api.Endpoints;
using Lunos.Api.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Serilog;
using Serilog.Sinks.TestCorrelator;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((context, services, configuration) =>
{
    configuration
        .ReadFrom.Configuration(context.Configuration)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.File(
            path: Path.Combine(context.HostingEnvironment.ContentRootPath, "Logs", "lunos-api-.log"),
            rollingInterval: RollingInterval.Day,
            outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {Message:lj}{NewLine}{Exception}");

    // Test-only sink: lets RequestLoggingTests assert on emitted events via TestCorrelator
    // without touching the file system or Console output.
    if (context.HostingEnvironment.IsEnvironment("Testing"))
    {
        configuration.WriteTo.TestCorrelator();
    }
});

var connectionString = builder.Configuration.GetConnectionString("MarketplaceDb")
    ?? throw new InvalidOperationException("ConnectionStrings:MarketplaceDb is not configured.");

builder.Services.AddDbContext<LunosDbContext>(options => options.UseSqlite(connectionString));
builder.Services.AddScoped<IDatabaseHealthChecker, SqliteDatabaseHealthChecker>();

var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
builder.Services.AddCors(options =>
{
    options.AddPolicy("LunosWebPolicy", policy =>
    {
        policy.WithOrigins(allowedOrigins)
              .WithMethods("GET", "POST", "OPTIONS")
              .AllowAnyHeader();
        // AllowCredentials intentionally omitted: no auth/cookies, credentialed CORS is unneeded surface area.
    });
});

var app = builder.Build();

// Global exception handler MUST be registered before endpoint mapping —
// otherwise unhandled exceptions bypass the { error: { code, message } } contract.
app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async context =>
    {
        context.Response.ContentType = "application/json";
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        var payload = new ErrorResponseDto(new ErrorDetailDto("internal_error", "An unexpected error occurred."));
        await context.Response.WriteAsJsonAsync(payload);
    });
});

app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0000} ms";
    // Bind explicitly to this host's configured logger instead of the process-global static
    // Log.Logger (Serilog.AspNetCore's default): when multiple hosts are built in the same
    // process (e.g. one WebApplicationFactory per xunit test class, running in parallel),
    // Log.Logger is whichever host's UseSerilog callback ran last, so a completed/disposed
    // host's request-logging completion events were being silently dropped for other hosts.
    options.Logger = app.Services.GetRequiredService<Serilog.ILogger>();
});

app.UseCors("LunosWebPolicy");

app.MapHealthEndpoints();
app.MapContactEndpoints();

// Tests substitute their own DbContext/connection per-test (see Lunos.Api.Tests) and migrate it
// themselves against this app's real DI container. Running the startup migration unconditionally
// here would instead migrate whatever appsettings.json resolves to under the test host (a stray
// dev DB file), never the test's actual in-memory connection — skip it under "Testing".
if (!app.Environment.IsEnvironment("Testing"))
{
    // SQLite won't create missing parent directories for a relative/absolute file path,
    // so a fresh checkout (dev) or a not-yet-provisioned D:\lunos-data (prod) fails Migrate()
    // with "unable to open database file" unless the directory exists first.
    var dataSource = new SqliteConnectionStringBuilder(connectionString).DataSource;
    var directory = Path.GetDirectoryName(Path.GetFullPath(dataSource));
    if (!string.IsNullOrEmpty(directory))
    {
        Directory.CreateDirectory(directory);
    }

    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<LunosDbContext>();
    db.Database.Migrate();
}

if (app.Environment.IsEnvironment("Testing"))
{
    // Exercises the real exception-handler pipeline registered above from an integration test.
    // Never mapped outside the Testing environment.
    app.MapGet("/__throw", () => { throw new InvalidOperationException("boom"); });
}

try
{
    app.Run();
}
finally
{
    Log.CloseAndFlush();
}

public partial class Program; // exposed for WebApplicationFactory<Program> in tests
