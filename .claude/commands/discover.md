# Discovery Documentation Generator

Generate comprehensive, AI-agent-friendly documentation for the specified functionality.

**Target:** $ARGUMENTS

## Instructions

You are creating discovery documentation that will be consumed by AI agents during development. The documentation must be structured, precise, and actionable.

### Step 1: Explore the Functionality

Use the Explore agent to thoroughly investigate:
1. All files related to the target functionality
2. Entry points (components, services, routes)
3. Dependencies (imports, injected services)
4. Data flow (inputs, outputs, state changes)
5. Integration points with other modules
6. Patterns and conventions used

### Step 2: Generate Documentation

Create a markdown file at `.claude/docs/{feature-name}.md` with this structure:

```markdown
# {Feature Name} - Discovery Documentation

> **Generated:** {date}
> **Scope:** {brief description}
> **Primary Files:** {list main files}

## Overview

{2-3 sentence summary of what this functionality does and its purpose in the system}

## Architecture

### Entry Points
| Type | Path | Description |
|------|------|-------------|
| Component | path/to/file.ts | What it does |
| Service | path/to/service.ts | What it provides |
| Route | /account/:id/path | Route purpose |

### File Structure
```
module/
├── components/
│   └── feature.component.ts    # Main component
├── services/
│   └── feature.service.ts      # Business logic
└── models/
    └── feature.model.ts        # Data models
```

## Dependencies

### Internal Dependencies
- **ServiceName** (`path/to/service.ts`) - Why it's used
- **ComponentName** (`path/to/component.ts`) - Integration purpose

### External Dependencies
- **Library** - Purpose (e.g., `ngx-bootstrap/modal` for dialogs)

## Data Flow

### Inputs
| Name | Type | Source | Description |
|------|------|--------|-------------|
| @Input() name | Type | Parent component | What it controls |

### Outputs
| Name | Type | Consumers | Description |
|------|------|-----------|-------------|
| @Output() event | EventEmitter<T> | Parent | When it fires |

### State Management
- **State Location:** Where state lives (service, component, storage)
- **State Shape:** Key properties and their purposes
- **State Updates:** How/when state changes

## Key Patterns

### Pattern Name
```typescript
// Code example showing the pattern
```
**When to use:** Explanation of when this pattern applies

## Integration Points

### With Other Modules
| Module | Integration Type | Description |
|--------|-----------------|-------------|
| SharedModule | Service injection | Uses XService for Y |
| PlanningModule | Event emission | Notifies on Z changes |

### API Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/resource | Fetches data |
| POST | /api/resource | Creates new item |

## Usage Examples

### Basic Usage
```typescript
// Example code for common use case
```

### Advanced Usage
```typescript
// Example code for complex scenarios
```

## Testing Considerations

- **Key test scenarios:** What to test
- **Mock requirements:** Services/data to mock
- **Test file location:** path/to/spec.ts

## Related Documentation

- [Related Feature](.claude/docs/related-feature.md)
- [Parent Module](.claude/docs/parent-module.md)

## Agent Notes

> **Quick Start:** Steps an agent should take to work with this feature
> **Common Pitfalls:** Mistakes to avoid
> **Extension Points:** Where new functionality can be added
```

### Step 3: Validate

After creating the documentation:
1. Verify all file paths are correct
2. Ensure code examples are accurate
3. Confirm the documentation is self-contained and actionable

### Output

Save the documentation to: `.claude/docs/{feature-name}.md`

Report back with:
- Documentation file path
- Summary of what was documented
- Key files an agent should read first

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
