"""A CI job that fixes the build: run the build, and if it fails, let Lunos fix it unattended.

Run it in a CI step after checkout, with a provider key in the environment (MISTRAL_API_KEY, …)
and Docker available for the sandbox:

    python ci_fix_build.py --build "npm run build" --budget 1.5

The agent works in a Docker sandbox with hard limits, and nothing it asks for is approved: a
refused permission is listed in the report, not granted. Its changes are handed back as a branch
or a patch (``report.results``), and the job pushes nothing itself.
"""

import argparse
import json
import subprocess
import sys

import lunos

parser = argparse.ArgumentParser()
parser.add_argument("--build", default="npm run build", help="the command that builds the project")
parser.add_argument("--budget", type=float, default=2.0, help="model spend limit")
parser.add_argument("--max-steps", type=int, default=40)
parser.add_argument("--max-time", default="20m")
parser.add_argument("--no-sandbox", action="store_true", help="run in this checkout (CI runners are disposable)")
args = parser.parse_args()

build = subprocess.run(args.build, shell=True, capture_output=True, text=True)
if build.returncode == 0:
    print("the build passes; nothing to fix")
    sys.exit(0)

log = (build.stdout + build.stderr)[-6000:]
report = lunos.run(
    f"The build fails. Fix it with the smallest change that makes `{args.build}` pass, "
    f"then run it again to check. Don't change tests to make them pass.\n\nBuild output:\n{log}",
    agent="build",
    budget=args.budget,
    max_steps=args.max_steps,
    max_time=args.max_time,
    sandbox=not args.no_sandbox,
)

print(f"{report.status} ({report.reason}) in {report.seconds}s, {report.steps} steps, cost {report.cost}")
for denied in report.denied:
    print(f"  refused: {denied.permission} {' '.join(denied.patterns)}")
if report.results:
    print(f"  results: {report.results}")
if report.error:
    print(f"  error: {report.error}")

# Machine-readable output for the next CI step.
with open("lunos-report.json", "w") as out:
    json.dump({"status": report.status, "reason": report.reason, "results": report.results, "report": report.file}, out)

sys.exit(0 if report.ok else 1)
