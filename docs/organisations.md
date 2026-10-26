# Organisations and roles

An organisation on Lunos Cloud is a company or team that shares a plan, a policy and team features. You join one by accepting an invitation, and your role in it decides what you can do there. `lunos org` manages it from the command line, and `/account` in the TUI shows your role in each one.

You need a [Lunos account](account.md) and `lunos login`. Organisations are a Lunos Cloud feature, so `lunos org` isn't available offline (`LUNOS_OFFLINE=1`) or with your organisation's own sign-in (`cloud.issuer`) unless it also sets `cloud.endpoint`.

## The roles

| Role             | Who                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **User**         | Everyone with a Lunos account. A new account is a User on Free, in no organisation.                              |
| **Member**       | A User who accepted an invitation. Members use what the organisation gives them, under its policy.               |
| **Admin**        | A Member an owner trusts with people and policy, but not with billing or ownership.                              |
| **Owner**        | Whoever bought the organisation's subscription, and anyone an owner promotes. Owners manage everything about it. |
| **Global Admin** | Lunos platform staff only. Nobody can give this role from Lunos, and it gives no access to your organisation.    |

What each role can do in an organisation:

| Action                                                       | Owner | Admin | Member |
| ------------------------------------------------------------ | :---: | :---: | :----: |
| See whom to ask (the owners)                                 |   ✓   |   ✓   |   ✓    |
| Use the organisation's team features                         |   ✓   |   ✓   |   ✓    |
| Leave the organisation                                       |   ✓   |   ✓   |   ✓    |
| List members and pending invitations                         |   ✓   |   ✓   |   —    |
| Invite, revoke invitations, change roles below owner, remove |   ✓   |   ✓   |   —    |
| Make or remove owners, transfer ownership                    |   ✓   |   —   |   —    |
| Billing: plan, seats, invoices, payment method               |   ✓   |   —   |   —    |
| Delete the organisation                                      |   ✓   |   —   |   —    |

Lunos Cloud checks every request against your role, on its servers. `lunos org` and the TUI don't decide anything themselves: they send the request and show the answer. When your role can't do something, Lunos Cloud says whom to ask. An Admin trying an Owner-only action sees:

```
Error: Only an organisation owner can do this. Ask: owner@acme.example
```

An organisation you aren't in answers as if it didn't exist (`You aren't a member of that organisation.`).

### Refusal codes

Each refusal carries a stable code, and `lunos org`, `/account` and scripts go by the code, never by the wording:

| Code                   | What it means                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `not_found`            | There's no such member or invitation (the message says which).                                |
| `not_member`           | You aren't a member of that organisation.                                                     |
| `owner_required`       | Only an owner can do this (billing, ownership, making owners). Admins get this too.           |
| `admin_required`       | Only an owner or admin can do this (members, invitations, policy).                            |
| `last_owner`           | You're the only owner of the organisations named. Transfer ownership first.                   |
| `suspended`            | The organisation or account is suspended.                                                     |
| `unverified`           | Your e-mail address isn't confirmed yet.                                                      |
| `reauth_required`      | The action needs a recent sign-in: sign in again, then retry.                                 |
| `break_glass_required` | Lunos platform staff only: the action needs an active break-glass grant.                      |
| `rate_limited`         | Too many requests, such as resending the confirmation e-mail; the message says when to retry. |
| `already_verified`     | Your e-mail address is already confirmed, so no new e-mail is sent.                           |

An older Lunos Cloud that sends no code is shown in its own words.

## Your organisations

```sh
lunos org list
```

```
Owner · Acme GmbH (acme)
Member · Beta Ltd (beta)
```

The other commands work on your only organisation, or on the one you name with `--org <id>`.

## Members and owners

```sh
lunos org members                           # members and pending invitations (owners and admins)
lunos org owners                            # the owners: whom to ask (every member)
lunos org invite sam@acme.example           # invite as a member; --role admin or --role owner
lunos org remove sam@acme.example           # remove someone (owners and admins)
lunos org owners add sam@acme.example       # make a member an owner (owners)
lunos org owners remove sam@acme.example    # make an owner a member again (owners)
lunos org leave                             # leave the organisation yourself
```

You can name people by e-mail address or by their account id. `lunos org remove me` is the same as `lunos org leave`.

An organisation always has at least one owner. Its last owner can't leave, be removed or be made a member until someone else is an owner (`last_owner`, naming the organisation).

## Invitations

An invitation goes by e-mail and lasts **7 days**. It can only be accepted by someone signed in with that address; a new address signs up for a free account first.

For owners and admins:

```sh
lunos org invitations --org acme            # the organisation's pending invitations, expired ones marked
lunos org revoke new@acme.example           # revoke one
```

For you:

```sh
lunos org invitations                       # the invitations waiting for you
lunos org accept beta
lunos org decline gamma
```

`/account` in the TUI lists the same invitations, with **Accept** and **Decline** for each.

## Transferring ownership

```sh
lunos org transfer sam@acme.example                 # sam becomes an owner, you become a member
lunos org transfer sam@acme.example --demote-to admin
lunos org transfer sam@acme.example --demote-to owner   # both of you stay owners
```

Only an owner can transfer ownership, and only to someone who is already a member. Transfer first if you want to leave an organisation you own alone, or to [delete your account](account.md#signing-in-and-out-later).

## In scripts

- `--json` prints the result as JSON. A refusal is JSON too, with Lunos Cloud's status, code and message, and the exit code is 1:

  ```json
  {
    "error": {
      "status": 403,
      "code": "admin_required",
      "legacyCode": "forbidden",
      "message": "Only an organisation owner or admin can do this. Ask: owner@acme.example"
    }
  }
  ```

- **Scripts matching `forbidden` should switch to `code`** (`owner_required` or `admin_required`); `legacyCode` is kept for one release, with the older code (`forbidden`, or `not_found` for `not_member`).
- `remove`, `leave`, `revoke`, `owners remove` and `transfer` ask before they change anything. `--yes` answers for you. Without a terminal, they refuse unless you pass `--yes`.
- `LUNOS_TOKEN` signs a script in without `lunos login`, as for the other cloud commands.

The full permission matrix, and what Lunos platform staff can and can't see, is in Lunos Cloud's "Roles and permissions" documentation.
