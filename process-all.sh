#!/bin/bash
# Process all pending bookmarks in batches of 5.
# Each bookmark gets: extraction → LLM classification → LLM enrichment → obsidian note
# Run with: nohup ./process-all.sh > process.log 2>&1 &

cd "$(dirname "$0")"

BATCH=5
PROCESSED=0
FAILED=0
START=$(date +%s)

echo "[$(date)] Starting bulk processing (batch size: $BATCH)"

while true; do
  COUNT=$(npx tsx src/index.ts status 2>/dev/null | grep "Pending:" | awk '{print $2}')
  if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
    END=$(date +%s)
    ELAPSED=$(( (END - START) / 60 ))
    echo "[$(date)] All done! Processed $PROCESSED bookmarks in ${ELAPSED}m. Failed: $FAILED"
    break
  fi
  echo "[$(date)] Batch starting... ($COUNT pending, $PROCESSED processed so far)"
  npx tsx src/index.ts process --limit $BATCH 2>/dev/null
  PROCESSED=$((PROCESSED + BATCH))
  sleep 3
done
