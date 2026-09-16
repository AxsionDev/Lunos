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
