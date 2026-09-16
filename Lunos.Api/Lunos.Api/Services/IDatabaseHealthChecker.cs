using Lunos.Api.Data;

namespace Lunos.Api.Services;

public interface IDatabaseHealthChecker
{
    Task<bool> CanConnectAsync(CancellationToken cancellationToken = default);
}

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
