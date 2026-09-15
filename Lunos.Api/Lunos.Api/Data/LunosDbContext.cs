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
