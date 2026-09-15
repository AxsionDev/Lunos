# Lunos Website — Phase 1 (Marketing Site + Contact Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship lunos.tech Phase 1 — a static-content-friendly Angular marketing site (`Lunos.Web`) plus a minimal ASP.NET Core API (`Lunos.Api`, SQLite-backed) that only serves `POST /api/v1/contact` and `GET /health` — deployed to a self-hosted Windows/IIS box via `build.ps1`/`deploy.ps1`.

**Architecture:** Two independently buildable, independently deployed projects (`Lunos.Web` Angular SPA with build-time prerendering for marketing routes; `Lunos.Api` ASP.NET Core Minimal API over EF Core + SQLite) living as sibling folders, calling each other only over cross-origin HTTPS + CORS — never through a reverse proxy or shared origin. Phase 2 (public marketplace browsing) is explicitly out of scope for every task below; see the outline at the end of this document.

**Tech Stack:** Angular 22 (standalone, zoneless, `provideZonelessChangeDetection`), .NET 10 Minimal APIs, EF Core 10 + `Microsoft.EntityFrameworkCore.Sqlite`, xUnit + EF Core SQLite in-memory provider, npm, PowerShell (`build.ps1`/`deploy.ps1`), IIS + ASP.NET Core Module v2.

**Spec:** `docs/lunos-website-prd.md` (product intent, architecture rationale, milestones) and `docs/lunos-website-technical-spec.md` (concrete schemas, contracts, folder layout, build order — this plan follows the latter's §10 build order task-for-task).

## Assumption requiring confirmation before Task 1

The technical spec's §1 tree is rooted at a folder literally named `lunos-website/`. This repository (`.../AxCode/WebSite`) currently has its old contents staged for deletion (see `git status`) and already hosts `docs/lunos-website-prd.md` at its own root — i.e., this repo *is* the lunos-website repo, not a container for one. **This plan places `Lunos.Web/`, `Lunos.Api/`, `build.ps1`, `deploy.ps1` directly at this repository's root**, dropping the spec's outer `lunos-website/` folder name as redundant with the repo itself. If a different layout is actually wanted (e.g. a literal `lunos-website/` subfolder, or a separate repo entirely), stop and confirm before running Task 1 — every task's `Files:` paths below assume repo-root placement.

## Blocking non-engineering inputs (attached to the tasks they gate, not left to a bottom-of-doc risk list)

- **XCOD-22 naming freeze** — still open per the PRD (§4, §12). Doesn't block building; blocks *real content going publicly live* under the "Lunos" name. Gates: the final go-live step of Task 10.
- **License decision** — not made anywhere upstream (PRD §12, tech spec §13). Gates: the License page content in Task 7.
- **Approved marketing copy** — only the home hero one-liner/tagline is quoted in the docs; FAQ, Sovereignty & Compliance, About, Changelog, and others have no approved copy yet (tech spec §13). Gates: final content sign-off in Task 7 — the task below builds real, structurally complete components and marks every unapproved copy block explicitly rather than inventing filler.
- **Moonlit Cove visual reference** (`https://claude.ai/artifact/8o73HhWXaTDu1THSsShsVF`) — the canonical visual source tech spec §6/§11 say to build against, not re-derive from the token table. This plan's executor cannot open arbitrary external artifact URLs from inside a coding session by default. Gates: the visual-fidelity verification step in Task 6 — open the reference yourself (or ask the user for a screenshot/export) before treating Task 6's styling as final; the token table, layout prose, and animation timings in the spec are followed literally in the meantime, which gets structure and behavior right even before pixel-matching.
- **Public reachability / DNS / static IP / cert** — PRD §12 flags this unresolved. Gates: Task 10 (real IIS deploy) — cannot complete until DNS points at a reachable address.

## Global Constraints

Copied verbatim from the specs — every task's implementation implicitly includes these:

- `.NET` SDK pinned via `global.json` (`"sdk": { "version": "10.0.100" }`, adjusted to whatever patch is actually installed) — no ambient "latest".
- Node pinned via `.nvmrc` at repo root — record the exact LTS version once decided.
- Package manager is **npm only** (`npm ci` in `build.ps1`) — no `pnpm`/`yarn` lockfiles.
- EF Core: `Microsoft.EntityFrameworkCore.Sqlite` + `Microsoft.EntityFrameworkCore.Design`, matching the pinned .NET SDK's default EF Core release line.
- .NET root namespace: `Lunos.Api` (`Lunos.Api.Models`, `Lunos.Api.Dtos`, `Lunos.Api.Services`, `Lunos.Api.Endpoints`, `Lunos.Api.Data`).
- Angular component selector prefix: `lunos-`.
- API base path is versioned: `/api/v1/` for everything **except** `GET /health`, which is unversioned and unprefixed (`https://api.lunos.tech/health`) — this is deliberate, not an inconsistency: `deploy.ps1`'s smoke test hits `/health` directly. Do not move it under `/api/v1`.
- IIS site names: `Lunos.Web`, `Lunos.Api` (match app pool names).
- Angular bootstrap is **zoneless**: `provideZonelessChangeDetection()`, no `zone.js` in polyfills. Never mix zone-based and zoneless patterns across components.
- All API responses are JSON. Every list endpoint (none exist in Phase 1, but the shape is fixed for Phase 2 continuity) uses envelope `{ "items": [], "total": 0, "page": 1, "pageSize": 20 }`.
- Every API error — deliberate (400/404) or unhandled (500) — returns `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status. The global exception handler must be registered in `Program.cs` **before** endpoint mapping, or unhandled exceptions bypass this shape.
- Health check AC overrides the naive reading of the happy-path table: if the DB is unreachable, `/health` returns a **non-200 status code**, never a 200 with `dbConnected: false` embedded — `deploy.ps1`'s smoke test only checks the status code.
- CORS: named policy (never the permissive default), allowed origins `https://lunos.tech` in Production and additionally `http://localhost:4200` in Development, methods `GET, POST, OPTIONS`, `AllowCredentials` **false**.
- SQLite file lives outside the IIS site's physical path: Production connection string points at `D:\lunos-data\marketplace.db`, never under `C:\inetpub\lunos-api`, so a `deploy.ps1` re-copy of the site folder never touches the database.
- EF Core migrations apply automatically on startup (`db.Database.Migrate()` in `Program.cs`) — no manual DBA step.
- Every task's automated tests are the completion gate — per tech spec §8, a feature isn't done until its acceptance criteria has a passing automated test, not a manual check. API tests use xUnit + EF Core's **SQLite in-memory provider** (an open, kept-alive `SqliteConnection` with `DataSource=:memory:`), not the separate `Microsoft.EntityFrameworkCore.InMemory` package — the two are different providers with different SQL semantics, and the spec means the SQLite one.
- Don't scaffold empty Phase 2 folders (`Ingestion/`, marketplace `Endpoints`/`Models`, `features/marketplace/`) in Phase 1. Don't add auth, plugin publishing, or any write endpoint beyond `POST /contact`. Don't route Angular → API calls through any same-origin proxy/rewrite rule.
- Color tokens (Catppuccin Mocha, dark-only, no `prefers-color-scheme` swap) as literal CSS custom properties in `src/styles/tokens.scss`:

  ```scss
  :root {
    --base: #1e1e2e;
    --mantle: #181825;
    --crust: #11111b;
    --surface0: #313244;
    --surface1: #45475a;
    --surface2: #585b70;
    --overlay0: #6c7086;
    --overlay1: #7f849c;
    --text: #cdd6f4;
    --subtext1: #bac2de;
    --subtext0: #a6adc8;
    --mauve: #cba6f7;
    --blue: #89b4fa;
    --sapphire: #74c7ec;
    --peach: #fab387;
    --yellow: #f9e2af;
    --green: #a6e3a1;
    --lavender: #b4befe;
  }
  ```

- Typography: **JetBrains Mono** (400/500/600/700) for wordmark, nav CTA, section eyebrows, tags, badges, code/install commands; **IBM Plex Sans** (400/500/600) for everything else. No third face.
- Hero scene shimmer animation: opacity `0.4 → 0.95 → 0.4` over `2.6s`, disabled entirely under `prefers-reduced-motion: reduce`.

---

## Task 1: `Lunos.Api` skeleton — EF Core, SQLite, Contact entity, exception handler, CORS

**Files:**
- Create: `global.json`
- Create: `Lunos.Api/Lunos.Api.sln`
- Create: `Lunos.Api/Lunos.Api/Lunos.Api.csproj`
- Create: `Lunos.Api/Lunos.Api/Program.cs`
- Create: `Lunos.Api/Lunos.Api/appsettings.json`
- Create: `Lunos.Api/Lunos.Api/appsettings.Development.json`
- Create: `Lunos.Api/Lunos.Api/appsettings.Production.json`
- Create: `Lunos.Api/Lunos.Api/Models/Contact.cs`
- Create: `Lunos.Api/Lunos.Api/Data/LunosDbContext.cs`
- Create: `Lunos.Api/Lunos.Api/Dtos/ErrorResponseDto.cs`
- Create: `Lunos.Api/Lunos.Api.Tests/Lunos.Api.Tests.csproj`
- Create: `Lunos.Api/Lunos.Api.Tests/ExceptionHandlingTests.cs`
- Create: `Lunos.Api/Lunos.Api.Tests/CorsPolicyTests.cs`
- Test: `Lunos.Api/Lunos.Api.Tests/ExceptionHandlingTests.cs`
- Test: `Lunos.Api/Lunos.Api.Tests/CorsPolicyTests.cs`

**Interfaces:**
- Produces: `LunosDbContext` (in `Lunos.Api.Data`) with `DbSet<Contact> Contacts`; `Contact` entity (`Id: Guid`, `Email: string`, `Message: string`, `Context: string?`, `CreatedUtc: DateTime`) in `Lunos.Api.Models`; `ErrorResponseDto` / `ErrorDetailDto` shape `{ error: { code, message } }` in `Lunos.Api.Dtos`; a named CORS policy `"LunosWebPolicy"` registered in `Program.cs`. Task 2 and Task 3 consume all of these.

- [ ] **Step 1: Scaffold the .NET solution and pin the SDK**

```bash
mkdir -p Lunos.Api/Lunos.Api Lunos.Api/Lunos.Api.Tests
cat > global.json <<'EOF'
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
EOF
cd Lunos.Api
dotnet new web -n Lunos.Api -o Lunos.Api
dotnet new xunit -n Lunos.Api.Tests -o Lunos.Api.Tests
dotnet new sln -n Lunos.Api
dotnet sln Lunos.Api.sln add Lunos.Api/Lunos.Api.csproj Lunos.Api.Tests/Lunos.Api.Tests.csproj
dotnet add Lunos.Api.Tests/Lunos.Api.Tests.csproj reference Lunos.Api/Lunos.Api.csproj
dotnet add Lunos.Api/Lunos.Api.csproj package Microsoft.EntityFrameworkCore.Sqlite
dotnet add Lunos.Api/Lunos.Api.csproj package Microsoft.EntityFrameworkCore.Design
dotnet add Lunos.Api.Tests/Lunos.Api.Tests.csproj package Microsoft.AspNetCore.Mvc.Testing
dotnet add Lunos.Api.Tests/Lunos.Api.Tests.csproj package Microsoft.EntityFrameworkCore.Sqlite
cd ..
```

- [ ] **Step 2: Write the Contact entity and DbContext**

`Lunos.Api/Lunos.Api/Models/Contact.cs`:
```csharp
namespace Lunos.Api.Models;

public class Contact
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public required string Message { get; set; }
    public string? Context { get; set; }
    public DateTime CreatedUtc { get; set; }
}
```

`Lunos.Api/Lunos.Api/Data/LunosDbContext.cs`:
```csharp
using Lunos.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Lunos.Api.Data;

public class LunosDbContext(DbContextOptions<LunosDbContext> options) : DbContext(options)
{
    public DbSet<Contact> Contacts => Set<Contact>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Contact>(entity =>
        {
            entity.HasKey(c => c.Id);
            entity.Property(c => c.Email).IsRequired();
            entity.Property(c => c.Message).IsRequired();
        });
    }
}
```

- [ ] **Step 3: Write the error envelope DTO**

`Lunos.Api/Lunos.Api/Dtos/ErrorResponseDto.cs`:
```csharp
namespace Lunos.Api.Dtos;

public record ErrorDetailDto(string Code, string Message, Dictionary<string, string[]>? Fields = null);

public record ErrorResponseDto(ErrorDetailDto Error);
```

- [ ] **Step 4: Write the failing test for the global exception handler shape**

This test must exercise `Program.cs`'s real pipeline, not a second exception handler registered inline in the test — otherwise the test passes even if `Program.cs`'s own `UseExceptionHandler` call is deleted, which is a vacuous gate. `Program.cs` (Step 6 below) maps a `/__throw` endpoint, but only under the `"Testing"` environment, so it never ships to Development/Production.

`Lunos.Api/Lunos.Api.Tests/ExceptionHandlingTests.cs`:
```csharp
using System.Net;
using System.Net.Http.Json;
using Lunos.Api.Dtos;
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter ExceptionHandlingTests`
Expected: FAIL — `Program` isn't a real minimal-API app with the exception handler wired yet (no `Program.cs` content, or the route doesn't exist).

- [ ] **Step 6: Implement `Program.cs` with EF Core, exception handler, and CORS wired in the correct order**

`Lunos.Api/Lunos.Api/Program.cs`:
```csharp
using Lunos.Api.Data;
using Lunos.Api.Dtos;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("MarketplaceDb")
    ?? throw new InvalidOperationException("ConnectionStrings:MarketplaceDb is not configured.");

builder.Services.AddDbContext<LunosDbContext>(options => options.UseSqlite(connectionString));

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

app.UseCors("LunosWebPolicy");

// Tests substitute their own DbContext/connection per-test (see Lunos.Api.Tests) and migrate it
// themselves against this app's real DI container. Running the startup migration unconditionally
// here would instead migrate whatever appsettings.json resolves to under the test host (a stray
// dev DB file), never the test's actual in-memory connection — skip it under "Testing".
if (!app.Environment.IsEnvironment("Testing"))
{
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

app.Run();

public partial class Program; // exposed for WebApplicationFactory<Program> in tests
```

`Lunos.Api/Lunos.Api/appsettings.json`:
```json
{
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } },
  "ConnectionStrings": { "MarketplaceDb": "Data Source=./data/marketplace.dev.db" },
  "Cors": { "AllowedOrigins": [] }
}
```

`Lunos.Api/Lunos.Api/appsettings.Development.json`:
```json
{
  "ConnectionStrings": { "MarketplaceDb": "Data Source=./data/marketplace.dev.db" },
  "Cors": { "AllowedOrigins": ["http://localhost:4200"] }
}
```

`Lunos.Api/Lunos.Api/appsettings.Production.json`:
```json
{
  "ConnectionStrings": { "MarketplaceDb": "Data Source=D:\\lunos-data\\marketplace.db" },
  "Cors": { "AllowedOrigins": ["https://lunos.tech"] },
  "Ingestion": { "IntervalMinutes": 60 }
}
```

Add `./data/` (the dev SQLite file location) to `.gitignore`.

- [ ] **Step 7: Run the exception-handler test to verify it passes**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter ExceptionHandlingTests`
Expected: PASS

- [ ] **Step 8: Write and run CORS preflight tests**

CORS misconfiguration is the single most likely thing to silently break the two-origin (Web/API) architecture at deploy time — assert the named policy actually behaves as configured, not just that it's registered.

`Lunos.Api/Lunos.Api.Tests/CorsPolicyTests.cs`:
```csharp
using System.Linq;
using System.Net.Http;
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
```

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter CorsPolicyTests`
Expected: PASS (both tests) — `Development` environment's `appsettings.Development.json` allows `http://localhost:4200`, so the first request gets the header back and the second (an origin never listed) doesn't.

- [ ] **Step 9: Create the initial EF Core migration**

Run: `dotnet ef migrations add InitialCreate --project Lunos.Api/Lunos.Api/Lunos.Api.csproj --startup-project Lunos.Api/Lunos.Api/Lunos.Api.csproj -o Data/Migrations`

(Install the `dotnet-ef` tool first if missing: `dotnet tool install --global dotnet-ef`.)

- [ ] **Step 10: Commit**

```bash
git add global.json Lunos.Api
git commit -m "feat(api): scaffold Lunos.Api with EF Core, SQLite, global exception handler, CORS"
```

---

## Task 2: `GET /health` with DB-unreachable acceptance criterion

**Files:**
- Create: `Lunos.Api/Lunos.Api/Services/IDatabaseHealthChecker.cs`
- Create: `Lunos.Api/Lunos.Api/Endpoints/HealthEndpoints.cs`
- Modify: `Lunos.Api/Lunos.Api/Program.cs`
- Test: `Lunos.Api/Lunos.Api.Tests/HealthEndpointTests.cs`

**Interfaces:**
- Consumes: `LunosDbContext` (Task 1).
- Produces: `IDatabaseHealthChecker.CanConnectAsync(): Task<bool>` and its real implementation `SqliteDatabaseHealthChecker`; extension method `MapHealthEndpoints(this IEndpointRouteBuilder app)`. Nothing later in Phase 1 consumes these directly, but Phase 2's `lastIngestionRunUtc` addition to `/health` (tech spec §4) extends this same endpoint — keep the handler easy to extend, don't inline it as a lambda with no seam.

- [ ] **Step 1: Write the health-check abstraction**

`Lunos.Api/Lunos.Api/Services/IDatabaseHealthChecker.cs`:
```csharp
namespace Lunos.Api.Services;

public interface IDatabaseHealthChecker
{
    Task<bool> CanConnectAsync(CancellationToken cancellationToken = default);
}
```

Real implementation, same file:
```csharp
using Lunos.Api.Data;

namespace Lunos.Api.Services;

public class SqliteDatabaseHealthChecker(LunosDbContext db) : IDatabaseHealthChecker
{
    public async Task<bool> CanConnectAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            return await db.Database.CanConnectAsync(cancellationToken);
        }
        catch
        {
            return false;
        }
    }
}
```

This seam exists specifically so the "DB missing or locked" acceptance criterion is testable without touching a real file system — a fake `IDatabaseHealthChecker` can return `false` or throw, and the endpoint's behavior under that condition is what the AC actually cares about, not SQLite's file-locking mechanics.

- [ ] **Step 2: Write the failing tests for both AC branches**

`Lunos.Api/Lunos.Api.Tests/HealthEndpointTests.cs`:
```csharp
using System.Net;
using System.Net.Http.Json;
using Lunos.Api.Data;
using Lunos.Api.Services;
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

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    public void Dispose() => _connection.Dispose();
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter HealthEndpointTests`
Expected: FAIL — `/health` doesn't exist yet, `IDatabaseHealthChecker` isn't registered.

- [ ] **Step 4: Implement the health endpoint**

`Lunos.Api/Lunos.Api/Endpoints/HealthEndpoints.cs`:
```csharp
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
```

Wire into `Program.cs` — add before `app.Run();`:
```csharp
builder.Services.AddScoped<IDatabaseHealthChecker, SqliteDatabaseHealthChecker>();
// ... (after app.UseCors("LunosWebPolicy");)
app.MapHealthEndpoints();
```
(Add `using Lunos.Api.Endpoints;` and `using Lunos.Api.Services;` to `Program.cs`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter HealthEndpointTests`
Expected: PASS (both tests)

- [ ] **Step 6: Commit**

```bash
git add Lunos.Api
git commit -m "feat(api): add GET /health with DB-unreachable non-200 acceptance criterion"
```

---

## Task 3: `POST /api/v1/contact`

**Files:**
- Create: `Lunos.Api/Lunos.Api/Dtos/ContactDtos.cs`
- Create: `Lunos.Api/Lunos.Api/Services/ContactValidator.cs`
- Create: `Lunos.Api/Lunos.Api/Endpoints/ContactEndpoints.cs`
- Modify: `Lunos.Api/Lunos.Api/Program.cs`
- Test: `Lunos.Api/Lunos.Api.Tests/ContactEndpointTests.cs`

**Interfaces:**
- Consumes: `LunosDbContext`, `Contact` (Task 1), `ErrorResponseDto`/`ErrorDetailDto` (Task 1).
- Produces: `ContactRequestDto { string Email, string Message, string? Context }`, `ContactResponseDto { Guid Id }`. Task 8 (Angular contact form) is the consumer of this exact request/response shape — the field names and casing (`email`, `message`, `context`, `id`, camelCase over the wire per ASP.NET Core's default JSON naming policy) must match what `ContactApiService` sends/expects.

- [ ] **Step 1: Write the DTOs**

`Lunos.Api/Lunos.Api/Dtos/ContactDtos.cs`:
```csharp
namespace Lunos.Api.Dtos;

// Email/Message are nullable here even though they're logically required: a non-nullable record
// property on a minimal-API request body makes ASP.NET Core's own model binding reject a missing
// or null field with its default ProblemDetails 400 shape *before* ContactValidator ever runs —
// breaking the "every error is { error: { code, message } }" contract. Nullable properties let
// binding always succeed and ContactValidator own every rejection path.
public record ContactRequestDto(string? Email, string? Message, string? Context);

public record ContactResponseDto(Guid Id);
```

- [ ] **Step 2: Write the failing tests**

`Lunos.Api/Lunos.Api.Tests/ContactEndpointTests.cs`:
```csharp
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using Lunos.Api.Data;
using Lunos.Api.Dtos;
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

    public void Dispose() => _connection.Dispose();
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter ContactEndpointTests`
Expected: FAIL — `/api/v1/contact` doesn't exist yet.

- [ ] **Step 4: Implement the validator and endpoint**

`Lunos.Api/Lunos.Api/Services/ContactValidator.cs`:
```csharp
using System.Text.RegularExpressions;
using Lunos.Api.Dtos;

namespace Lunos.Api.Services;

public static partial class ContactValidator
{
    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
    private static partial Regex EmailPattern();

    public static Dictionary<string, string[]>? Validate(ContactRequestDto request)
    {
        var fields = new Dictionary<string, string[]>();

        if (string.IsNullOrWhiteSpace(request.Email) || !EmailPattern().IsMatch(request.Email))
        {
            fields["email"] = ["A valid email address is required."];
        }

        if (string.IsNullOrWhiteSpace(request.Message))
        {
            fields["message"] = ["Message is required."];
        }

        return fields.Count == 0 ? null : fields;
    }
}
```

`Lunos.Api/Lunos.Api/Endpoints/ContactEndpoints.cs`:
```csharp
using Lunos.Api.Data;
using Lunos.Api.Dtos;
using Lunos.Api.Models;
using Lunos.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Lunos.Api.Endpoints;

public static class ContactEndpoints
{
    public static void MapContactEndpoints(this IEndpointRouteBuilder app)
    {
        // Not rate-limited in v1; structured as a single small handler so a rate limiter is a one-line addition later.
        app.MapPost("/api/v1/contact", async (ContactRequestDto request, LunosDbContext db) =>
        {
            var validationErrors = ContactValidator.Validate(request);
            if (validationErrors is not null)
            {
                return Results.Json(
                    new ErrorResponseDto(new ErrorDetailDto("validation_error", "One or more fields are invalid.", validationErrors)),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // Null-forgiving: ContactValidator has already guaranteed these are non-empty by this point.
            var contact = new Contact
            {
                Id = Guid.NewGuid(),
                Email = request.Email!,
                Message = request.Message!,
                Context = request.Context,
                CreatedUtc = DateTime.UtcNow
            };

            db.Contacts.Add(contact);
            await db.SaveChangesAsync();

            return Results.Created($"/api/v1/contact/{contact.Id}", new ContactResponseDto(contact.Id));
        });
    }
}
```

Wire into `Program.cs` (after `app.MapHealthEndpoints();`, add `using Lunos.Api.Endpoints;` already present):
```csharp
app.MapContactEndpoints();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter ContactEndpointTests`
Expected: PASS (all four tests)

- [ ] **Step 6: Run the full API test suite before moving to the frontend**

Run: `dotnet test Lunos.Api/Lunos.Api.sln`
Expected: PASS (all tests across Tasks 1–3)

- [ ] **Step 7: Commit**

```bash
git add Lunos.Api
git commit -m "feat(api): add POST /api/v1/contact with server-side validation"
```

---

## Task 4: Structured request logging (rolling file sink)

PRD §9 and tech spec §4 both require structured logging — request path, status code, and duration per request at minimum — written to a rolling file under a `Logs/` folder, since there's no centralized log aggregation on a single self-hosted box. This is what makes `/health` and any future `LastRefreshStatus` (Phase 2) debuggable after the fact rather than only in the moment. The built-in `ILogger` console/debug providers alone don't give a rolling file with per-request duration, so this task adds Serilog specifically for that.

**Files:**
- Modify: `Lunos.Api/Lunos.Api/Lunos.Api.csproj`
- Modify: `Lunos.Api/Lunos.Api/Program.cs`
- Modify: `Lunos.Api/Lunos.Api.Tests/Lunos.Api.Tests.csproj`
- Create: `Lunos.Api/Lunos.Api.Tests/RequestLoggingTests.cs`
- Test: `Lunos.Api/Lunos.Api.Tests/RequestLoggingTests.cs`

**Interfaces:**
- Consumes: the middleware ordering established in Task 1 (`UseExceptionHandler` → this task's `UseSerilogRequestLogging` → `UseCors` → endpoint mapping).
- Produces: nothing a later task calls directly, but fixes the on-disk `Logs/` folder convention that Task 10's IIS checklist must grant the API app pool identity write access to (added there).

- [ ] **Step 1: Add the Serilog packages**

```bash
dotnet add Lunos.Api/Lunos.Api/Lunos.Api.csproj package Serilog.AspNetCore
dotnet add Lunos.Api/Lunos.Api/Lunos.Api.csproj package Serilog.Sinks.File
dotnet add Lunos.Api/Lunos.Api.Tests/Lunos.Api.Tests.csproj package Serilog.Sinks.TestCorrelator
```

- [ ] **Step 2: Write the failing test**

`Lunos.Api/Lunos.Api.Tests/RequestLoggingTests.cs`:
```csharp
using Lunos.Api.Data;
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter RequestLoggingTests`
Expected: FAIL — Serilog isn't wired into `Program.cs` yet, so no matching log event exists.

- [ ] **Step 4: Wire Serilog into `Program.cs`**

Add near the top of `Program.cs` (after the `using` block, before `var builder = ...`):
```csharp
using Serilog;
using Serilog.Sinks.TestCorrelator;
```

Immediately after `var builder = WebApplication.CreateBuilder(args);`, add:
```csharp
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
```

Add the request-logging middleware right after `app.UseExceptionHandler(...)` and before `app.UseCors("LunosWebPolicy");`, so it wraps as much of the pipeline as possible:
```csharp
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0000} ms";
});
```

Replace the plain `app.Run();` at the bottom with:
```csharp
try
{
    app.Run();
}
finally
{
    Log.CloseAndFlush();
}
```

Add `./Logs/` (the dev rolling-file location, written relative to the content root when running locally) to `.gitignore` alongside `./data/`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `dotnet test Lunos.Api/Lunos.Api.sln --filter RequestLoggingTests`
Expected: PASS

- [ ] **Step 6: Run the full API test suite**

Run: `dotnet test Lunos.Api/Lunos.Api.sln`
Expected: PASS (all tests across Tasks 1–4)

- [ ] **Step 7: Commit**

```bash
git add Lunos.Api .gitignore
git commit -m "feat(api): add Serilog structured request logging with rolling file sink"
```

---

## Task 5: `Lunos.Web` workspace skeleton — routing, tokens, zoneless bootstrap, HTTP layer

**Files:**
- Create: `Lunos.Web/` (Angular workspace, generated)
- Create: `Lunos.Web/src/styles/tokens.scss`
- Create: `Lunos.Web/src/environments/environment.ts`
- Create: `Lunos.Web/src/environments/environment.production.ts`
- Create: `Lunos.Web/src/app/app.routes.ts`
- Create: `Lunos.Web/src/app/app.config.ts`
- Create: `Lunos.Web/src/app/core/request-state.ts`
- Modify: `Lunos.Web/src/index.html`
- Modify: `Lunos.Web/angular.json`
- Create: `.nvmrc`

**Interfaces:**
- Produces: `RequestState<T>` union type (`{ status: 'idle' | 'loading' | 'loaded' | 'error'; data?: T; error?: string }`) used by every API-calling component; the full Phase 1 route table in `app.routes.ts`. Tasks 6, 7, and 8 all consume this route table and the token classes; Task 8 consumes `RequestState<T>`.

- [ ] **Step 1: Generate the Angular workspace pinned to Angular 22, zoneless, Vitest**

```bash
echo "22" > .nvmrc
npx -p @angular/cli@22 ng new Lunos.Web --standalone --style=scss --routing=false --skip-git --package-manager=npm
```

When prompted for the unit test runner, select the Vitest/Web Test Runner option (Angular 22's default replacing Karma) — if the CLI doesn't prompt in non-interactive mode, explicitly set it afterward:

`Lunos.Web/angular.json` — under the `test` builder for the app's target, pin:
```json
"test": {
  "builder": "@angular/build:unit-test",
  "options": {
    "runner": "vitest",
    "tsConfig": "tsconfig.spec.json"
  }
}
```
(Exact builder name may need adjusting to whatever `ng new` actually scaffolds — the requirement is that the runner is pinned explicitly in `angular.json`, not left ambient.)

- [ ] **Step 2: Remove zone.js and enable zoneless bootstrap**

`Lunos.Web/src/app/app.config.ts`:
```ts
import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
  ],
};
```

Remove `"zone.js"` from the `polyfills` array in `Lunos.Web/angular.json` (both `build` and `test` targets) and remove the `import 'zone.js';` line from `Lunos.Web/src/main.ts` if the schematic generated one.

- [ ] **Step 3: Write the token stylesheet**

`Lunos.Web/src/styles/tokens.scss` — paste the full `:root { ... }` block from this plan's **Global Constraints** section verbatim, then import it globally in `Lunos.Web/src/styles.scss`:
```scss
@use 'styles/tokens';

:root {
  --font-mono: 'JetBrains Mono', monospace;
  --font-sans: 'IBM Plex Sans', sans-serif;
}

body {
  background: var(--base);
  color: var(--text);
  font-family: var(--font-sans);
  margin: 0;
}
```

Load both Google Fonts in `Lunos.Web/src/index.html` `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 4: Write environments**

`Lunos.Web/src/environments/environment.ts` (dev):
```ts
export const environment = {
  production: false,
  apiBaseUrl: 'https://localhost:5443/api/v1',
};
```

`Lunos.Web/src/environments/environment.production.ts`:
```ts
export const environment = {
  production: true,
  apiBaseUrl: 'https://api.lunos.tech/api/v1',
};
```

Pin the dev API port (`5443` above) in `Lunos.Api/Lunos.Api/Properties/launchSettings.json` so it isn't ambient — set `applicationUrl` for the `https` profile to `https://localhost:5443`.

- [ ] **Step 5: Write the shared request-state type**

`Lunos.Web/src/app/core/request-state.ts`:
```ts
export type RequestState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: T }
  | { status: 'error'; message: string };

export const idle = <T>(): RequestState<T> => ({ status: 'idle' });
export const loading = <T>(): RequestState<T> => ({ status: 'loading' });
export const loaded = <T>(data: T): RequestState<T> => ({ status: 'loaded', data });
export const failed = <T>(message: string): RequestState<T> => ({ status: 'error', message });
```

- [ ] **Step 6: Write the Phase 1 route table (no marketplace routes, no marketplace nav entries anywhere)**

`Lunos.Web/src/app/app.routes.ts`:
```ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/marketing/home/home.component').then(m => m.HomeComponent) },
  { path: 'product', loadComponent: () => import('./features/marketing/product/product.component').then(m => m.ProductComponent) },
  { path: 'roadmap', loadComponent: () => import('./features/marketing/roadmap/roadmap.component').then(m => m.RoadmapComponent) },
  { path: 'docs', loadComponent: () => import('./features/marketing/docs-install/docs-install.component').then(m => m.DocsInstallComponent) },
  { path: 'sovereignty', loadComponent: () => import('./features/marketing/sovereignty/sovereignty.component').then(m => m.SovereigntyComponent) },
  { path: 'faq', loadComponent: () => import('./features/marketing/faq/faq.component').then(m => m.FaqComponent) },
  { path: 'changelog', loadComponent: () => import('./features/marketing/changelog/changelog.component').then(m => m.ChangelogComponent) },
  { path: 'contact', loadComponent: () => import('./features/marketing/contact/contact.component').then(m => m.ContactComponent) },
  { path: 'about', loadComponent: () => import('./features/marketing/about/about.component').then(m => m.AboutComponent) },
  { path: 'license', loadComponent: () => import('./features/marketing/license/license.component').then(m => m.LicenseComponent) },
  // '/marketplace', '/marketplace/:id', '/plugins', '/plugins/:id' are Phase 2 — do not add until Phase 2 starts.
  { path: '**', loadComponent: () => import('./features/marketing/not-found/not-found.component').then(m => m.NotFoundComponent) },
];
```

These routes reference components created in Task 7 — this task only needs the file to exist with correct paths; Task 7 creates the referenced files and is where the production build is first verified end to end (its own Step 7). Don't build here: the lazy-loaded components these routes point at don't exist until Task 7, so a build attempted now would fail on missing modules — that's expected, not a defect to work around by temporarily editing the route table.

- [ ] **Step 7: Commit**

```bash
git add .nvmrc Lunos.Web
git commit -m "feat(web): scaffold Lunos.Web with zoneless bootstrap, tokens, environments, route table"
```

---

## Task 6: Shared layout components — Nav, Footer, Hero/moonlit scene, Sovereignty strip, Feature card

**Files:**
- Create: `Lunos.Web/src/app/shared/nav-bar/nav-bar.component.ts`
- Create: `Lunos.Web/src/app/shared/footer/footer.component.ts`
- Create: `Lunos.Web/src/app/shared/hero-scene/hero-scene.component.ts`
- Create: `Lunos.Web/src/app/shared/sovereignty-strip/sovereignty-strip.component.ts`
- Create: `Lunos.Web/src/app/shared/feature-card/feature-card.component.ts`
- Test: `Lunos.Web/src/app/shared/nav-bar/nav-bar.component.spec.ts`

**Interfaces:**
- Consumes: token CSS variables from `tokens.scss` (Task 5).
- Produces: `<lunos-nav-bar>`, `<lunos-footer>`, `<lunos-hero-scene>`, `<lunos-sovereignty-strip [statement]="string">`, `<lunos-feature-card [phase]="string" [heading]="string" [body]="string">` — Task 7's marketing pages consume all five.

- [ ] **Step 1: Write the failing test asserting the nav bar has no marketplace link in Phase 1**

`Lunos.Web/src/app/shared/nav-bar/nav-bar.component.spec.ts`:
```ts
import { render, screen } from '@testing-library/angular';
import { NavBarComponent } from './nav-bar.component';

describe('NavBarComponent', () => {
  it('does not render a Marketplace link in Phase 1', async () => {
    await render(NavBarComponent);
    expect(screen.queryByText(/marketplace/i)).toBeNull();
  });

  it('renders the wordmark and a mono install CTA', async () => {
    await render(NavBarComponent);
    expect(screen.getByText('lunos')).toBeTruthy();
    expect(screen.getByText(/\$ install/i)).toBeTruthy();
  });
});
```

(If `@testing-library/angular` isn't already a dependency: `npm install --save-dev @testing-library/angular @testing-library/jest-dom`. If the pinned runner's assertion API differs, adapt `expect`/`screen` calls to that runner's equivalent — the behavior under test, not the assertion library, is what matters.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd Lunos.Web && npx ng test --include='**/nav-bar.component.spec.ts'`
Expected: FAIL — `NavBarComponent` doesn't exist yet.

- [ ] **Step 3: Implement the nav bar**

`Lunos.Web/src/app/shared/nav-bar/nav-bar.component.ts`:
```ts
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'lunos-nav-bar',
  standalone: true,
  imports: [RouterLink],
  template: `
    <nav class="nav-bar">
      <a routerLink="/" class="wordmark">lunos</a>
      <div class="nav-links">
        <a routerLink="/product">Product</a>
        <a routerLink="/roadmap">Roadmap</a>
        <a routerLink="/docs">Docs</a>
        <a routerLink="/sovereignty">Sovereignty</a>
        <a routerLink="/faq">FAQ</a>
        <a routerLink="/changelog">Changelog</a>
        <a routerLink="/about">About</a>
        <!-- Marketplace link intentionally omitted: not built until Phase 2, don't link to a 404. -->
      </div>
      <a routerLink="/docs" class="install-cta">$ install</a>
    </nav>
  `,
  styles: `
    .nav-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 2rem;
      background: var(--crust);
    }
    .wordmark {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--text);
      text-decoration: none;
    }
    .nav-links {
      display: flex;
      gap: 1.5rem;
    }
    .nav-links a {
      color: var(--subtext1);
      text-decoration: none;
      font-family: var(--font-sans);
    }
    .install-cta {
      font-family: var(--font-mono);
      color: var(--crust);
      background: var(--mauve);
      padding: 0.4rem 0.9rem;
      border-radius: 4px;
      text-decoration: none;
    }
    @media (max-width: 640px) {
      .nav-links { display: none; }
    }
  `,
})
export class NavBarComponent {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd Lunos.Web && npx ng test --include='**/nav-bar.component.spec.ts'`
Expected: PASS

- [ ] **Step 5: Implement Footer, Hero/moonlit scene, Sovereignty strip, Feature card (no dedicated spec beyond a smoke render — these are presentational, and their acceptance criteria in the spec is visual fidelity, not behavior)**

`Lunos.Web/src/app/shared/footer/footer.component.ts`:
```ts
import { Component } from '@angular/core';

@Component({
  selector: 'lunos-footer',
  standalone: true,
  template: `<footer class="footer"><span>lunos · lunos.tech</span></footer>`,
  styles: `
    .footer {
      text-align: center;
      padding: 2rem;
      color: var(--overlay1);
      font-family: var(--font-mono);
    }
  `,
})
export class FooterComponent {}
```

`Lunos.Web/src/app/shared/hero-scene/hero-scene.component.ts`:
```ts
import { Component } from '@angular/core';

@Component({
  selector: 'lunos-hero-scene',
  standalone: true,
  template: `
    <section class="hero">
      <p class="eyebrow">SOVEREIGN AI TOOLING</p>
      <h1 class="wordmark">lunos</h1>
      <p class="tagline">Own your AI coding agent, end to end.</p>
      <div class="scene" aria-hidden="true">
        <div class="cloud cloud-a"></div>
        <div class="cloud cloud-b"></div>
        <div class="moon"></div>
        <div class="water"></div>
        <div class="reflection"></div>
      </div>
      <div class="terminal-card">
        <span class="prompt">$ curl -fsSL https://lunos.tech/install.sh | sh</span><span class="cursor">▌</span>
      </div>
    </section>
  `,
  styles: `
    .hero {
      text-align: center;
      padding: 4rem 1rem;
      background: var(--crust);
    }
    .eyebrow {
      font-family: var(--font-mono);
      text-transform: uppercase;
      color: var(--sapphire);
      letter-spacing: 0.08em;
      font-size: 0.85rem;
    }
    .wordmark {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: clamp(40px, 8vw, 72px);
      color: var(--text);
      margin: 0.5rem 0;
    }
    .tagline {
      color: var(--subtext1);
      font-family: var(--font-sans);
    }
    .scene {
      position: relative;
      height: 220px;
      margin: 2rem auto;
      max-width: 640px;
    }
    .cloud {
      position: absolute;
      background: var(--lavender);
      filter: blur(12px);
      opacity: 0.5;
      border-radius: 50%;
    }
    .cloud-a { width: 140px; height: 40px; top: 10px; left: 10%; }
    .cloud-b { width: 100px; height: 30px; top: 40px; right: 15%; }
    .moon {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, var(--yellow), var(--peach));
      box-shadow: 0 0 40px 10px var(--peach);
    }
    .water {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40%;
      background: var(--surface0);
      border-top: 1px solid var(--overlay0);
    }
    .reflection {
      position: absolute;
      bottom: 5px;
      left: 50%;
      transform: translateX(-50%);
      width: 40px;
      height: 20px;
      border-radius: 50%;
      background: var(--peach);
      opacity: 0.4;
      animation: shimmer 2.6s ease-in-out infinite;
    }
    @keyframes shimmer {
      0% { opacity: 0.4; }
      50% { opacity: 0.95; }
      100% { opacity: 0.4; }
    }
    @media (prefers-reduced-motion: reduce) {
      .reflection { animation: none; opacity: 0.6; }
    }
    .terminal-card {
      display: inline-block;
      background: var(--mantle);
      color: var(--green);
      font-family: var(--font-mono);
      padding: 0.75rem 1.25rem;
      border-radius: 6px;
      border: 1px solid var(--surface1);
    }
    .cursor {
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .cursor { animation: none; }
    }
  `,
})
export class HeroSceneComponent {}
```

`Lunos.Web/src/app/shared/sovereignty-strip/sovereignty-strip.component.ts`:
```ts
import { Component, Input } from '@angular/core';

@Component({
  selector: 'lunos-sovereignty-strip',
  standalone: true,
  template: `<div class="strip"><p><span class="emphasis">{{ statement }}</span></p></div>`,
  styles: `
    .strip {
      background: var(--mantle);
      border-top: 1px solid var(--surface1);
      border-bottom: 1px solid var(--surface1);
      padding: 1.5rem 2rem;
      text-align: center;
      color: var(--subtext1);
      font-family: var(--font-sans);
    }
    .emphasis { color: var(--peach); }
  `,
})
export class SovereigntyStripComponent {
  @Input({ required: true }) statement!: string;
}
```

`Lunos.Web/src/app/shared/feature-card/feature-card.component.ts`:
```ts
import { Component, Input } from '@angular/core';

@Component({
  selector: 'lunos-feature-card',
  standalone: true,
  template: `
    <article class="card">
      <span class="phase-tag">{{ phase }}</span>
      <h3>{{ heading }}</h3>
      <p>{{ body }}</p>
    </article>
  `,
  styles: `
    .card {
      background: var(--surface0);
      border: 1px solid var(--surface1);
      border-radius: 8px;
      padding: 1.5rem;
    }
    .phase-tag {
      display: inline-block;
      font-family: var(--font-mono);
      background: var(--mauve);
      color: var(--crust);
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      margin-bottom: 0.75rem;
    }
    h3 { color: var(--text); font-family: var(--font-sans); }
    p { color: var(--subtext0); }
  `,
})
export class FeatureCardComponent {
  @Input({ required: true }) phase!: string;
  @Input({ required: true }) heading!: string;
  @Input({ required: true }) body!: string;
}
```

- [ ] **Step 6: Visual fidelity verification (manual, blocked pending reference access)**

Open `https://claude.ai/artifact/8o73HhWXaTDu1THSsShsVF` (the Moonlit Cove reference tech spec §6/§11 name as canonical) and compare against the rendered components above — spacing, exact gradient stops, and card layout may need adjustment to match. If the reference can't be opened from the execution environment, ask the user for a screenshot/export before treating this task's CSS as final. The structure, token usage, and animation timing above are already literal per the spec and are correct regardless of this step's outcome.

- [ ] **Step 7: Commit**

```bash
git add Lunos.Web
git commit -m "feat(web): add shared layout components (nav, footer, hero scene, sovereignty strip, feature card)"
```

---

## Task 7: Marketing content pages

**Files:**
- Create: `Lunos.Web/src/app/features/marketing/home/home.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/product/product.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/roadmap/roadmap.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/docs-install/docs-install.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/sovereignty/sovereignty.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/faq/faq.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/changelog/changelog.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/about/about.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/license/license.component.ts`
- Create: `Lunos.Web/src/app/features/marketing/not-found/not-found.component.ts`

**Interfaces:**
- Consumes: `NavBarComponent`, `FooterComponent`, `HeroSceneComponent`, `SovereigntyStripComponent`, `FeatureCardComponent` (Task 6); route paths from `app.routes.ts` (Task 5).
- Produces: nothing further downstream in Phase 1 — this task closes out the route table so Task 9's build step has real content to bundle.

**Content-gating note:** Only the home hero one-liner/tagline ("Own your AI coding agent, end to end." — already used in Task 6's `HeroSceneComponent`) and the sovereignty self-hosting claim are directly quotable from the PRD/tech spec. Every other page below ships with structurally real, functioning components and a single clearly labeled `<!-- COPY PENDING -->` HTML comment marking the block(s) that need PRD-owner-approved copy before this task counts as content-complete — per tech spec §13, don't have an agent draft filler copy under the project owner's name. The License page in particular renders nothing until the license decision (PRD §12) exists.

- [ ] **Step 1: Home**

`Lunos.Web/src/app/features/marketing/home/home.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { HeroSceneComponent } from '../../../shared/hero-scene/hero-scene.component';
import { SovereigntyStripComponent } from '../../../shared/sovereignty-strip/sovereignty-strip.component';

@Component({
  selector: 'lunos-home',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, HeroSceneComponent, SovereigntyStripComponent],
  template: `
    <lunos-nav-bar />
    <lunos-hero-scene />
    <lunos-sovereignty-strip
      statement="lunos.tech itself runs on self-hosted EU infrastructure — the sovereignty pitch, checkable." />
    <lunos-footer />
  `,
})
export class HomeComponent {}
```

- [ ] **Step 2: Product (parity table — structure ready, row data pending roadmap doc extraction)**

`Lunos.Web/src/app/features/marketing/product/product.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-product',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Product</h1>
      <!-- COPY PENDING: parity table rows sourced from product-vision-roadmap.md, not reproduced in the PRD/tech spec doc set this plan was built from. -->
    </main>
    <lunos-footer />
  `,
})
export class ProductComponent {}
```

- [ ] **Step 3: Roadmap, FAQ, Changelog, About, Sovereignty — same pattern, each with its own `COPY PENDING` marker where the source content isn't in the doc set**

`Lunos.Web/src/app/features/marketing/roadmap/roadmap.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { FeatureCardComponent } from '../../../shared/feature-card/feature-card.component';

@Component({
  selector: 'lunos-roadmap',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, FeatureCardComponent],
  template: `
    <lunos-nav-bar />
    <main class="grid">
      <h1>Roadmap</h1>
      <!-- COPY PENDING: five-phase roadmap content mirrors product-vision-roadmap.md's current shipped/in-progress state; generate from the same source as the Jira-derived release notes per PRD §7, not hand-duplicated. -->
    </main>
    <lunos-footer />
  `,
  styles: `.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; padding: 2rem; } @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }`,
})
export class RoadmapComponent {}
```

`Lunos.Web/src/app/features/marketing/faq/faq.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-faq',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>FAQ</h1>
      <!-- COPY PENDING: "why fork opencode" and other FAQ entries not drafted in the PRD/tech spec — needs PO-approved copy per tech spec §13. -->
    </main>
    <lunos-footer />
  `,
})
export class FaqComponent {}
```

`Lunos.Web/src/app/features/marketing/changelog/changelog.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-changelog',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Changelog</h1>
      <!-- COPY PENDING: build-in-public log entries — source from Jira release notes per PRD §7, same source as the Roadmap page. -->
    </main>
    <lunos-footer />
  `,
})
export class ChangelogComponent {}
```

`Lunos.Web/src/app/features/marketing/about/about.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-about',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>About</h1>
      <!-- COPY PENDING: project background copy not drafted in the PRD/tech spec. -->
    </main>
    <lunos-footer />
  `,
})
export class AboutComponent {}
```

`Lunos.Web/src/app/features/marketing/sovereignty/sovereignty.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { SovereigntyStripComponent } from '../../../shared/sovereignty-strip/sovereignty-strip.component';

@Component({
  selector: 'lunos-sovereignty',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, SovereigntyStripComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Sovereignty & Compliance</h1>
      <lunos-sovereignty-strip
        statement="lunos.tech runs on self-hosted EU infrastructure — the same sovereignty guarantee the project ships to its users." />
      <!-- COPY PENDING: detailed compliance narrative beyond the strip statement not drafted in the PRD/tech spec. -->
    </main>
    <lunos-footer />
  `,
})
export class SovereigntyComponent {}
```

- [ ] **Step 4: Docs/Install — the one Phase 1 page with an explicit, non-content-gated functional requirement (a real install command)**

`Lunos.Web/src/app/features/marketing/docs-install/docs-install.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-docs-install',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Install</h1>
      <pre class="install-cmd">curl -fsSL https://lunos.tech/install.sh | sh</pre>
      <!-- COPY PENDING: terminal recording/GIF — PRD §7 calls this the single highest-leverage marketing asset; don't ship this page without it. Needs an actual recorded install session, not a placeholder image. -->
    </main>
    <lunos-footer />
  `,
  styles: `.install-cmd { font-family: var(--font-mono); background: var(--mantle); color: var(--green); padding: 1rem; border-radius: 6px; }`,
})
export class DocsInstallComponent {}
```

- [ ] **Step 5: License — renders nothing until the license decision exists (PRD §12), by design**

`Lunos.Web/src/app/features/marketing/license/license.component.ts`:
```ts
import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-license',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>License</h1>
      <!-- BLOCKED: license text cannot be written until the license decision (PRD §12 / tech spec §13) is made. Do not guess a license here. -->
    </main>
    <lunos-footer />
  `,
})
export class LicenseComponent {}
```

- [ ] **Step 6: Not Found**

`Lunos.Web/src/app/features/marketing/not-found/not-found.component.ts`:
```ts
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';

@Component({
  selector: 'lunos-not-found',
  standalone: true,
  imports: [NavBarComponent, RouterLink],
  template: `
    <lunos-nav-bar />
    <main class="not-found">
      <h1>404</h1>
      <p>That page doesn't exist. <a routerLink="/">Back home</a>.</p>
    </main>
  `,
  styles: `.not-found { text-align: center; padding: 4rem; }`,
})
export class NotFoundComponent {}
```

- [ ] **Step 7: Build the whole app to confirm the route table resolves**

Run: `cd Lunos.Web && npx ng build --configuration production`
Expected: Build succeeds with no missing-module errors.

- [ ] **Step 8: Commit**

```bash
git add Lunos.Web
git commit -m "feat(web): add Phase 1 marketing content pages (routes wired, COPY PENDING markers where content is unapproved)"
```

---

## Task 8: Contact page — form, validation, API wiring, four-state handling

**Files:**
- Create: `Lunos.Web/src/app/core/contact-api.service.ts`
- Create: `Lunos.Web/src/app/features/marketing/contact/contact.component.ts`
- Test: `Lunos.Web/src/app/features/marketing/contact/contact.component.spec.ts`

**Interfaces:**
- Consumes: `RequestState<T>` (Task 5); `environment.apiBaseUrl` (Task 5); the `POST /api/v1/contact` request/response shape from Task 3 (`{ email, message, context? }` → `201 { id }` or `400 { error: { code: "validation_error", fields } }`).
- Produces: `ContactApiService.submit(payload: ContactPayload): Observable<{ id: string }>` — nothing downstream in Phase 1 consumes this further.

**State mapping for this task's "all four states" requirement (tech spec §5):** `empty` = pristine, unsubmitted form; `loading` = submit in flight; `loaded` = success confirmation shown; `error` = submission failed, retry action shown, form re-enabled.

- [ ] **Step 1: Write the API service**

`Lunos.Web/src/app/core/contact-api.service.ts`:
```ts
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ContactPayload {
  email: string;
  message: string;
  context?: string;
}

export interface ContactResponse {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class ContactApiService {
  constructor(private readonly http: HttpClient) {}

  submit(payload: ContactPayload): Observable<ContactResponse> {
    return this.http.post<ContactResponse>(`${environment.apiBaseUrl}/contact`, payload);
  }
}
```

- [ ] **Step 2: Write the failing tests — including the "no request sent on invalid email" AC**

`Lunos.Web/src/app/features/marketing/contact/contact.component.spec.ts`:
```ts
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ContactComponent } from './contact.component';
import { ContactApiService } from '../../../core/contact-api.service';
import { environment } from '../../../../environments/environment';

describe('ContactComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ContactComponent, HttpClientTestingModule],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('blocks submission and sends no HTTP request when the email is invalid', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('not-an-email');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    httpMock.expectNone(() => true); // asserts zero HTTP calls were made, not just that the visible outcome looks right
    expect(component.state().status).toBe('error');
  });

  it('submits and transitions to loaded on success', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('dev@example.com');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    expect(component.state().status).toBe('loading');

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/contact`);
    req.flush({ id: '11111111-1111-1111-1111-111111111111' });

    expect(component.state().status).toBe('loaded');
  });

  it('transitions to error with a retry path on API failure', () => {
    const fixture = TestBed.createComponent(ContactComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.email.set('dev@example.com');
    component.message.set('Evaluating this for a pilot.');
    component.submit();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/contact`);
    req.flush({ error: { code: 'internal_error', message: 'boom' } }, { status: 500, statusText: 'Server Error' });

    expect(component.state().status).toBe('error');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd Lunos.Web && npx ng test --include='**/contact.component.spec.ts'`
Expected: FAIL — `ContactComponent` doesn't exist yet.

- [ ] **Step 4: Implement the contact component**

`Lunos.Web/src/app/features/marketing/contact/contact.component.ts`:
```ts
import { Component, signal } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { ContactApiService } from '../../../core/contact-api.service';
import { RequestState, idle, loading, loaded, failed } from '../../../core/request-state';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Component({
  selector: 'lunos-contact',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main class="contact">
      <h1>Design-partner / Contact</h1>

      @if (state().status === 'loaded') {
        <p class="success">Thanks — we'll be in touch.</p>
      } @else {
        <form (submit)="onSubmit($event)">
          <label>
            Email
            <input type="email" [value]="email()" (input)="email.set($any($event.target).value)" />
          </label>
          <label>
            What are you evaluating this for?
            <textarea [value]="message()" (input)="message.set($any($event.target).value)"></textarea>
          </label>
          @if (state().status === 'error') {
            <p class="error-text">{{ errorMessage() }}</p>
          }
          <button type="submit" [disabled]="state().status === 'loading'">
            {{ state().status === 'loading' ? 'Sending…' : 'Send' }}
          </button>
        </form>
      }
    </main>
    <lunos-footer />
  `,
  styles: `
    .contact { max-width: 480px; margin: 0 auto; padding: 2rem; }
    label { display: block; margin-bottom: 1rem; color: var(--subtext1); }
    input, textarea { width: 100%; background: var(--surface0); border: 1px solid var(--surface1); color: var(--text); padding: 0.5rem; border-radius: 4px; }
    .error-text { color: var(--peach); }
    .success { color: var(--green); }
  `,
})
export class ContactComponent {
  readonly email = signal('');
  readonly message = signal('');
  readonly state = signal<RequestState<{ id: string }>>(idle());

  constructor(private readonly contactApi: ContactApiService) {}

  errorMessage(): string {
    const current = this.state();
    return current.status === 'error' ? current.message : '';
  }

  onSubmit(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  submit(): void {
    if (!EMAIL_PATTERN.test(this.email())) {
      this.state.set(failed('Enter a valid email address.'));
      return; // no HTTP call is made — validation fails before contactApi.submit() is ever invoked
    }
    if (this.message().trim().length === 0) {
      this.state.set(failed('Message is required.'));
      return;
    }

    this.state.set(loading());
    this.contactApi.submit({ email: this.email(), message: this.message() }).subscribe({
      next: (response) => this.state.set(loaded(response)),
      error: () => this.state.set(failed('Something went wrong — please try again.')),
    });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd Lunos.Web && npx ng test --include='**/contact.component.spec.ts'`
Expected: PASS (all three tests)

- [ ] **Step 6: Run the full Angular test suite and a production build**

Run: `cd Lunos.Web && npx ng test && npx ng build --configuration production`
Expected: PASS / build succeeds

- [ ] **Step 7: Commit**

```bash
git add Lunos.Web
git commit -m "feat(web): wire contact page to POST /api/v1/contact with four-state handling"
```

---

## Task 9: `build.ps1` / `deploy.ps1`

**Files:**
- Create: `build.ps1`
- Create: `deploy.ps1`
- Create: `README.md`

**Interfaces:**
- Consumes: `Lunos.Web` production build output (Tasks 5–8), `Lunos.Api.csproj` (Tasks 1–4).
- Produces: a versioned zip artifact under `./artifacts/lunos-<version>.zip`, consumed manually by Task 10's IIS deploy.

- [ ] **Step 1: Confirm the actual Angular build output layout before writing `deploy.ps1`'s copy logic**

Run: `cd Lunos.Web && npx ng build --configuration production --output-path ../artifacts/manual-check/web` and inspect where `index.html` lands:

Run: `find artifacts/manual-check/web -name index.html`

Modern Angular application builders (the `@angular/build:application` builder, default since Angular 17+) emit into a `browser/` subfolder (e.g. `artifacts/manual-check/web/browser/index.html`), not directly into the given `--output-path`. Note the actual result — the deploy step below is written to handle either layout, but must be pointed at whichever one this build actually produces.

- [ ] **Step 2: Write `build.ps1`, adjusted for the confirmed output layout**

`build.ps1`:
```powershell
# build.ps1 — run from the repo root; produces ./artifacts/<version>/{web,api}
param(
    [string]$Version = (Get-Date -Format "yyyyMMdd-HHmmss")
)

$ErrorActionPreference = "Stop"
$artifactRoot = Join-Path $PSScriptRoot "artifacts\$Version"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Write-Host "Building Lunos.Web (Angular)..."
Push-Location "$PSScriptRoot\Lunos.Web"
npm ci
npx ng build --configuration production --output-path "$artifactRoot\web"
Pop-Location

# The Angular application builder emits into a browser/ subfolder — flatten it here
# so deploy.ps1 can robocopy $artifactRoot\web straight to the IIS site root
# without needing to know about the builder's internal layout.
$browserOutput = Join-Path $artifactRoot "web\browser"
if (Test-Path $browserOutput) {
    Get-ChildItem $browserOutput | Move-Item -Destination (Join-Path $artifactRoot "web") -Force
    Remove-Item $browserOutput -Recurse -Force
}

Write-Host "Publishing Lunos.Api (.NET)..."
dotnet publish "$PSScriptRoot\Lunos.Api\Lunos.Api\Lunos.Api.csproj" `
    -c Release `
    -o "$artifactRoot\api" `
    --runtime win-x64 `
    --self-contained false

"$Version" | Out-File -Encoding utf8 (Join-Path $artifactRoot "version.txt")

Write-Host "Zipping artifact..."
Compress-Archive -Path "$artifactRoot\*" -DestinationPath "$PSScriptRoot\artifacts\lunos-$Version.zip" -Force

Write-Host "Done: artifacts\lunos-$Version.zip"
```

- [ ] **Step 3: Write `deploy.ps1`**

`deploy.ps1`:
```powershell
# deploy.ps1 — run ON the IIS box, as Administrator, against a build.ps1 artifact zip
param(
    [Parameter(Mandatory = $true)][string]$ArtifactZip,
    [string]$WebSitePath = "C:\inetpub\lunos-web",
    [string]$ApiSitePath = "C:\inetpub\lunos-api",
    [string]$WebAppPool  = "Lunos.Web",
    [string]$ApiAppPool  = "Lunos.Api",
    [string]$BackupRoot  = "C:\inetpub\_backups",
    [int]$KeepBackups    = 5
)

Import-Module WebAdministration
$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$extractPath = Join-Path $env:TEMP "lunos-deploy-$stamp"
Expand-Archive -Path $ArtifactZip -DestinationPath $extractPath -Force

# Sanity check before touching any live app pool: fail fast if build.ps1's flatten step didn't run.
$indexPath = Join-Path $extractPath "web\index.html"
if (-not (Test-Path $indexPath)) {
    throw "Expected $indexPath to exist — check build.ps1's browser/ flatten step before deploying."
}

Write-Host "Stopping app pools..."
Stop-WebAppPool -Name $WebAppPool
Stop-WebAppPool -Name $ApiAppPool

function Backup-AndReplace($source, $target, $label, $excludeDirs = @()) {
    $backupDir = Join-Path $BackupRoot "$label-$stamp"
    if (Test-Path $target) {
        Write-Host "Backing up $label to $backupDir"
        Copy-Item -Path $target -Destination $backupDir -Recurse -Force
    }
    Write-Host "Deploying $label..."
    $robocopyArgs = @($source, $target, "/MIR", "/R:3", "/W:5")
    if ($excludeDirs.Count -gt 0) {
        $robocopyArgs += "/XD"
        $robocopyArgs += $excludeDirs
    }
    robocopy @robocopyArgs | Out-Null
}

Backup-AndReplace "$extractPath\web" $WebSitePath "web"
# Exclude Logs\ from the mirror: it lives under the API's own site path (unlike the SQLite file,
# which is deliberately outside it — see §7), and Task 4's rolling file sink writes there. An /MIR
# without this exclusion would delete accumulated log files on every deploy.
Backup-AndReplace "$extractPath\api" $ApiSitePath "api" -excludeDirs @("Logs")

foreach ($label in @("web", "api")) {
    Get-ChildItem $BackupRoot -Directory -Filter "$label-*" |
        Sort-Object CreationTime -Descending |
        Select-Object -Skip $KeepBackups |
        Remove-Item -Recurse -Force
}

Write-Host "Starting app pools..."
Start-WebAppPool -Name $WebAppPool
Start-WebAppPool -Name $ApiAppPool

Start-Sleep -Seconds 5
try {
    $response = Invoke-WebRequest -Uri "https://api.lunos.tech/health" -TimeoutSec 15 -UseBasicParsing
    if ($response.StatusCode -ne 200) {
        Write-Warning "API health check returned status $($response.StatusCode) after deploy — investigate before announcing this release."
    } else {
        Write-Host "API health check OK: $($response.Content)"
    }
} catch {
    Write-Warning "API health check FAILED after deploy — investigate before announcing this release."
}

Remove-Item $extractPath -Recurse -Force
Write-Host "Deploy complete."
```

- [ ] **Step 4: Dry-run `build.ps1` end to end**

Run: `pwsh ./build.ps1` (or `powershell ./build.ps1` on Windows)
Expected: produces `artifacts/lunos-<timestamp>.zip`; unzip it and confirm `web/index.html` and `api/Lunos.Api.dll` both exist at the top level of their respective folders.

- [ ] **Step 5: Write a minimal `README.md` covering local dev + build/deploy usage**

`README.md`:
```markdown
# Lunos Website

Two independently deployable projects:
- `Lunos.Web/` — Angular 22 marketing site (zoneless, standalone, prerendered marketing routes)
- `Lunos.Api/` — .NET 10 minimal API (SQLite-backed), Phase 1 scope: `POST /api/v1/contact`, `GET /health`

## Local development

- API: `cd Lunos.Api/Lunos.Api && dotnet run` (binds `https://localhost:5443` per `launchSettings.json`)
- Web: `cd Lunos.Web && npm ci && npx ng serve` (binds `http://localhost:4200`, calls the API above via `environment.ts`)

## Build & deploy

- `./build.ps1` — produces a versioned zip under `./artifacts/`
- `./deploy.ps1 -ArtifactZip <path>` — run on the target IIS box as Administrator; see `docs/lunos-website-technical-spec.md` §9 for the one-time IIS provisioning checklist.
```

- [ ] **Step 6: Commit**

```bash
git add build.ps1 deploy.ps1 README.md
git commit -m "feat(deploy): add build.ps1/deploy.ps1 with corrected browser/ output flattening"
```

---

## Task 10: IIS provisioning and first real deploy — infrastructure task, not pure coding

**Files:** none (this task executes the tech spec's §9 checklist against physical/administrative infrastructure — no repo changes beyond what Task 9 already produced).

**Interfaces:**
- Consumes: `artifacts/lunos-<version>.zip` from Task 9; `deploy.ps1` from Task 9.
- Produces: a live, publicly reachable `https://lunos.tech` and `https://api.lunos.tech`.

This task requires hands-on access to the target Windows box and DNS/registrar control that a coding agent does not have. It is included here because it's the actual completion of PRD Milestone 1 ("Marketing site + contact form live") — treat the steps below as an operator checklist to execute, not something to automate away.

- [ ] **Step 1:** Install the ASP.NET Core Hosting Bundle (includes ASP.NET Core Module v2) and the URL Rewrite module on the Windows box.
- [ ] **Step 2:** Create `C:\inetpub\lunos-web`, `C:\inetpub\lunos-api`, and `D:\lunos-data`; grant the API app pool identity modify rights on `D:\lunos-data`, and also on `C:\inetpub\lunos-api\Logs` (Task 4's Serilog rolling file sink writes there, relative to the API's content root — `deploy.ps1`'s `robocopy` for the `api` label already excludes `Logs\` from its `/MIR` sync, per Task 9, so accumulated log files survive redeploys).
- [ ] **Step 3:** Create app pools `Lunos.Web` and `Lunos.Api`, both "No Managed Code".
- [ ] **Step 4:** Create IIS site `Lunos.Web` (physical path `C:\inetpub\lunos-web`, binding `https://lunos.tech` + `http://lunos.tech` redirecting to https, app pool `Lunos.Web`). Add a `web.config` under `C:\inetpub\lunos-web` with an IIS URL Rewrite rule that falls back unmatched paths to `index.html` (SPA client-side routing only — not a proxy to the API).
- [ ] **Step 5:** Create IIS site `Lunos.Api` (physical path `C:\inetpub\lunos-api`, binding `https://api.lunos.tech`, app pool `Lunos.Api`).
- [ ] **Step 6:** Install TLS certificates for both bindings via `win-acme` against Let's Encrypt (one cert per hostname or a SAN cert covering both), and confirm automated renewal is scheduled.
- [ ] **Step 7 — blocked on the "public reachability" open question (PRD §12):** confirm `lunos.tech` and `api.lunos.tech` A/CNAME records point at the box's actually-reachable address (static IP or DDNS + port forwarding resolved first). Do not proceed past this step until that's resolved.
- [ ] **Step 8:** Run `./deploy.ps1 -ArtifactZip <path-to-Task-9-artifact>` on the box; confirm `https://lunos.tech` loads and `https://api.lunos.tech/health` returns 200.
- [ ] **Step 9 — blocked on XCOD-22 naming freeze:** before announcing or linking this site publicly under the "Lunos" name, confirm XCOD-22 has actually closed. If it hasn't, the site can be live at the URL for internal/testing purposes, but should not be promoted per the GTM channels (Show HN, Reddit, Fosstodon) yet.

---

## Task 11: Build-time prerendering + WCAG 2.1 AA pass (PRD Milestone 2)

**Files:**
- Modify: `Lunos.Web/angular.json`
- Modify: `Lunos.Web/src/app/app.config.ts` (if the prerender builder requires a server entry config — confirm against whatever Angular 22's `ng add @angular/ssr --skip-install` scaffolds for the static prerender path)
- Modify: any marketing components flagged by the accessibility audit in Step 3

**Interfaces:**
- Consumes: the full Phase 1 route table and all marketing components (Tasks 5–8).
- Produces: static pre-rendered HTML per marketing route in the production build output — no runtime Node process, per PRD §8's explicit correction ("build-time prerendering, not `@angular/ssr`'s live server-rendering mode").

- [ ] **Step 1: Enable build-time prerendering for marketing routes only**

Run: `cd Lunos.Web && npx ng add @angular/ssr` and, when configuring, select **static site generation / prerendering** rather than a live SSR server — or, if using the standalone prerender builder directly, set `"prerender": true` and `"outputMode": "static"` (exact keys depend on the installed Angular 22 CLI's schema — check `npx ng build --help` for the application builder's prerender options) under the `build` target's `options` in `angular.json`. List only the Phase 1 marketing routes for prerendering (`/`, `/product`, `/roadmap`, `/docs`, `/sovereignty`, `/faq`, `/changelog`, `/contact`, `/about`, `/license`) — do not configure this for any future marketplace routes when Phase 2 adds them, since those stay client-rendered per the PRD.

- [ ] **Step 2: Verify prerendered output**

Run: `cd Lunos.Web && npx ng build --configuration production`

Then check that each marketing route produced a real HTML file with content (not an empty shell):
```bash
grep -l "lunos" artifacts/manual-check/web/*/index.html 2>/dev/null || find dist -name "index.html" -exec grep -L "lunos" {} \;
```
Expected: every marketing route's `index.html` contains rendered content (e.g. the wordmark or nav links), not just an empty `<app-root></app-root>`.

- [ ] **Step 3: Run an automated accessibility check against the running dev build**

Run: `cd Lunos.Web && npx ng serve &` then, in another shell, `npx @axe-core/cli http://localhost:4200 http://localhost:4200/product http://localhost:4200/contact http://localhost:4200/docs` (install with `npm install --save-dev @axe-core/cli` if not already present).
Expected: zero critical/serious violations. Fix any found (common culprits here: the `aria-hidden` hero scene needs a text alternative for the tagline that's already rendered as plain text elsewhere in the DOM — verify it is; form inputs in `ContactComponent` need associated `<label>` elements, which Task 8 already wired via nested `<label>` wrapping). `--overlay0` (`#6c7086`) on `--base` (`#1e1e2e`) is the one token pair in the palette that's known-risky — roughly 3.4:1, below the 4.5:1 AA threshold for body text — so if axe (or manual review) finds a violation on any Task 7 copy block that landed on `--overlay0` for body text, swap it to `--overlay1` (`#7f849c`, ~5.4:1 against `--crust`/`--base`) or `--subtext0`/`--subtext1`, which are the tokens the design system already designates for body/secondary text.

- [ ] **Step 4: Re-run the full test suite and production build after any fixes**

Run: `cd Lunos.Web && npx ng test && npx ng build --configuration production`
Expected: PASS / build succeeds

- [ ] **Step 5: Commit**

```bash
git add Lunos.Web
git commit -m "feat(web): enable build-time prerendering for marketing routes, WCAG 2.1 AA fixes"
```

---

## Self-review notes

- **Spec coverage:** Every Phase 1 item in tech spec §10's build order (steps 1–7) maps to a task above (Tasks 1–3 ↔ step 1–2; Tasks 5–6 ↔ step 3; Task 7 ↔ step 4; Task 8 ↔ step 5; Tasks 9–10 ↔ step 6; Task 11 ↔ step 7). Task 4 (structured logging) isn't in tech spec §10's numbered list but is required by PRD §9/tech spec §4's observability requirement, so it's placed where it naturally falls in dependency order (after the API endpoints exist, before the frontend starts). PRD §7's functional requirements, §9's non-functional requirements (security/CORS, accessibility, sovereignty narrative), and tech spec §§1–9 (folder structure, naming, data model, API contract, routes, design system, configuration, IIS checklist) are each addressed in the task that owns that concern. Tech spec §12 (local dev DB setup) is folded into Task 1 (`appsettings.Development.json`, gitignored dev SQLite file, `db.Database.Migrate()` on startup).
- **Placeholder scan:** no `TODO`/`TBD` in code steps; the `COPY PENDING` and `BLOCKED` HTML comments in Task 7 are intentional, spec-mandated content gates (tech spec §13 explicitly warns against drafting filler copy), not deferred engineering work.
- **Type consistency:** `ContactPayload`/`ContactResponse` (Task 8, Angular) match `ContactRequestDto`/`ContactResponseDto` (Task 3, API) field-for-field under ASP.NET Core's default camelCase JSON policy — `ContactRequestDto`'s properties are nullable (Task 3 Step 1) specifically so binding never rejects a request before `ContactValidator` runs; the Angular side always sends well-formed strings, so this doesn't change what `ContactApiService` sends. `RequestState<T>` (Task 5) is the exact type `ContactComponent` (Task 8) uses. `IDatabaseHealthChecker` (Task 2) is the only seam Task 2's tests replace; `IDatabaseHealthChecker`/`LunosDbContext` overrides across Tasks 2–4's tests all use the same `WithWebHostBuilder` + `UseEnvironment("Testing")` + migrate-via-`factory.Services` pattern established in Task 2 — no task reinvents it.

---

## Phase 2 — deferred, not detailed here

Per the PRD's explicit re-phase and tech spec §11's guardrail ("don't build any Phase 2 item in Phase 1"), the marketplace-hosting phase is intentionally left as an outline, not bite-sized tasks — writing granular TDD tasks now would mean guessing at exactly what tech spec §13 says not to guess at (XCOD-8's manifest schema, XCOD-34/35's actual resolution logic, XCOD-9's seed catalog, XCOD-33's hosting reconciliation). When Phase 2 starts, write a fresh plan using this same skill, seeded by tech spec §10 steps 8–11:

- **Entry gates** (must be resolved or explicitly handed over before this phase's plan is written): XCOD-8 manifest schema, XCOD-34/35 real ingestion/resolution logic (reuse, don't re-derive — tech spec §11), XCOD-9 production seed catalog, XCOD-33 hosting/API-contract decision reconciled against the self-hosted-on-Windows approach, marketplace data storage choice confirmed against XCOD-34's dev/staging implementation.
- **Outline** (tech spec §10 steps 8–11): Marketplace + Plugin entities/migration/seed data, extend `/health` with `lastIngestionRunUtc`; `GET /marketplaces`, `GET /marketplaces/{id}`, `GET /plugins`, `GET /plugins/search`, `GET /plugins/{id}` per tech spec §4's Phase 2 table; ingestion `IHostedService` per XCOD-35's logic; marketplace/plugin Angular pages wired to the live API with the nav link re-enabled.
- Full data model, API contract, route table, and visual design for the marketplace screen are already specified in tech spec §§3–6 and PRD §7 — that groundwork doesn't need to be redone, only implemented once the entry gates above clear.
