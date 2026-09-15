namespace Lunos.Api.Dtos;

public record ErrorDetailDto(string Code, string Message, Dictionary<string, string[]>? Fields = null);

public record ErrorResponseDto(ErrorDetailDto Error);
