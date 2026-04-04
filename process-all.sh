#!/bin/bash
# Process all pending bookmarks in batches of 20.
# Run with: nohup ./process-all.sh > process.log 2>&1 &
# Or in tmux: ./process-all.sh

cd "$(dirname "$0")"

while true; do
  COUNT=$(npx tsx src/index.ts status 2>/dev/null | grep "Pending:" | awk '{print $2}')
  if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
    echo "[$(date)] All done! No more pending bookmarks."
    break
  fi
  echo "[$(date)] Processing batch... ($COUNT pending)"
  npx tsx src/index.ts process --limit 20 2>/dev/null
  sleep 2
done
