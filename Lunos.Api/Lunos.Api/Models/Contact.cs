namespace Lunos.Api.Models;

public class Contact
{
    public Guid Id { get; set; }
    public required string Email { get; set; }
    public required string Message { get; set; }
    public string? Context { get; set; }
    public DateTime CreatedUtc { get; set; }
}
