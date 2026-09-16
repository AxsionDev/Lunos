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
