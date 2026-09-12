# /check-logs - Application Log Inspector

Inspect persistent Serilog log files, database state, and Hangfire job status for the Toplo Customer Portal.

## Arguments: $ARGUMENTS

## Instructions

You are a log analysis agent. Based on the arguments provided, perform the appropriate action below.

### 1. Determine the log file path

The application uses Serilog with daily rolling files. The log files are located at:
```
Toplo.CustomerPortal/logs/toplo-YYYYMMDD.log
```

Use today's date to construct the filename. For example, if today is 2026-02-09, the file is `Toplo.CustomerPortal/logs/toplo-20260209.log`.

If the file doesn't exist, check what log files are available with:
```
Glob pattern: Toplo.CustomerPortal/logs/toplo-*.log
```
and use the most recent one.

### 2. Route by argument

**If no arguments or empty** (`$ARGUMENTS` is empty):
- Read the last 100 lines of today's log file using the Read tool
- Summarize what you see: request count, any warnings/errors, active services

**If `errors`:**
- Use Grep to search the log file for `\[ERR\]` or `\[FTL\]` patterns
- Present each error with timestamp, source context, and message
- Group similar errors together
- Provide count and severity assessment

**If `invoice-import`:**
- Use Grep to search the log file for patterns: `InvoiceImport|InvoiceImportJob|InvoiceImportService|ParseAndStage|BlobStorage`
- Show the import pipeline activity chronologically
- Highlight any failures or warnings

**If `hangfire`:**
- Use Grep to search the log file for `Hangfire` entries
- Show job execution status, any failures, timing information

**If `db-errors`:**
- Run a SQL query against the database to find recent failed import jobs:
```bash
cd Toplo.CustomerPortal && dotnet ef dbcontext sql --project ../Toplo.CustomerPortal.Data "SELECT TOP 20 Id, OrganizationId, FileName, Status, ErrorMessage, CreatedDate FROM ImportJobs WHERE Status = 4 ORDER BY CreatedDate DESC"
```
- If that doesn't work, use the connection string from `appsettings.json` with `sqlcmd` or inform the user that direct DB query requires a running application
- If arguments contain `--org N`, filter by `OrganizationId = N`

**If `db-errors --org N`** (where N is a number):
- Same as `db-errors` but filtered to the specific organization ID

**If `all`:**
- Run the `errors` check
- Run the `db-errors` check
- Read the last 50 lines of the log file
- Combine into a unified system health report

### 3. Output format

Present findings in this structure:

```
## Log Analysis Report

**Log file:** [filename]
**Time range:** [first timestamp] - [last timestamp]
**Analysis type:** [what was requested]

### Findings

[Structured findings here]

### Error Summary
- Total errors: N
- Total warnings: N
- Key patterns: [list]

### Recommendations
[If errors found, suggest actionable next steps]
```

### Important notes
- If no log file exists yet, tell the user to start the application first (`cd Toplo.CustomerPortal && dotnet run`) so that Serilog creates the log directory and files.
- Always show the actual file path you're reading from.
- For large log files, focus on the most recent and most relevant entries.
- When showing errors, include enough context (2-3 lines before/after) to understand what triggered them.
