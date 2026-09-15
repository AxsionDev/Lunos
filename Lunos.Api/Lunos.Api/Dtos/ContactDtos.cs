namespace Lunos.Api.Dtos;

// Email/Message are nullable here even though they're logically required: a non-nullable record
// property on a minimal-API request body makes ASP.NET Core's own model binding reject a missing
// or null field with its default ProblemDetails 400 shape *before* ContactValidator ever runs —
// breaking the "every error is { error: { code, message } }" contract. Nullable properties let
// binding always succeed and ContactValidator own every rejection path.
public record ContactRequestDto(string? Email, string? Message, string? Context);

public record ContactResponseDto(Guid Id);
