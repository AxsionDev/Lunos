#!/bin/bash
# The fix Lunos shipped (XCOD-118, e271b320cf).
sed -i 's/`${value.days} days /`${value.days} ${value.days === 1 ? "day" : "days"} /; s/`${value.days} days (/`${value.days} ${value.days === 1 ? "day" : "days"} (/' /app/lag.ts
