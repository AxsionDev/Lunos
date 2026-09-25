# Organisation policy for Lunos

`managed.json` is a sample policy: EU-only models with an audit log, sharing off, one provider,
only the built-in marketplace, and updates announced but never installed on their own. Every
key it sets is listed in `$locked`, so developers can't change them from their own config,
environment variables, CLI flags or in-session commands. Edit it to match your policy.

Lunos reads the policy from a system location that only administrators can write:

| OS      | Put the file at                                   | Or deploy                          |
| ------- | ------------------------------------------------- | ---------------------------------- |
| Linux   | `/etc/lunos/managed.json`                         | configuration management (below)   |
| macOS   | `/Library/Application Support/Lunos/managed.json` | `lunos-policy.mobileconfig` by MDM |
| Windows | `%ProgramData%\Lunos\managed.json`                | Intune or GPO (below)              |

Check it on a developer machine with `lunos debug config --sources`: every locked key shows the
`managed` layer and `locked`.

## macOS (MDM)

`lunos-policy.mobileconfig` carries the same keys in the `tech.lunos.managed` preference domain.
Replace both `PayloadUUID` values with your own (`uuidgen`), then upload it to your MDM as a custom
configuration profile. An MDM profile takes precedence over the file.

## Windows (Intune or GPO)

Lunos has no registry policy. Deploy the file:

- **Intune:** a Win32 app or a PowerShell platform script that writes
  `%ProgramData%\Lunos\managed.json`, run in the system context.
- **Group Policy:** Computer Configuration → Preferences → Windows Settings → **Files**, source a
  share holding `managed.json`, destination `%ProgramData%\Lunos\managed.json`, action _Replace_.

Make sure standard users can read but not modify `%ProgramData%\Lunos`.

## Linux (configuration management)

Ansible, for example:

```yaml
- name: Lunos organisation policy
  ansible.builtin.copy:
    src: managed.json
    dest: /etc/lunos/managed.json
    owner: root
    group: root
    mode: "0644"
```

## Notes

- `lunos upgrade` never writes to these locations.
- The upstream opencode locations (`/etc/opencode`, `/Library/Application Support/opencode`,
  `%ProgramData%\opencode`, and the `ai.opencode.managed` domain) are still read, with a
  deprecation warning, **only when no Lunos location exists**. Move the file across.
- `$locked` is ignored in any other config file.
