#!/bin/bash
# Process all pending bookmarks in batches of 5.
# Each bookmark gets: extraction → LLM classification → LLM enrichment → obsidian note
# Run with: nohup ./process-all.sh > process.log 2>&1 &

cd "$(dirname "$0")"

BATCH=5
MAX_ITEMS=${1:-0}  # Pass a limit as first arg, 0 = unlimited
PROCESSED=0
FAILED=0
START=$(date +%s)

echo "[$(date)] Starting bulk processing (batch size: $BATCH, limit: ${MAX_ITEMS:-unlimited})"

while true; do
  # Stop if we've hit the limit
  if [ "$MAX_ITEMS" -gt 0 ] && [ "$PROCESSED" -ge "$MAX_ITEMS" ]; then
    END=$(date +%s)
    ELAPSED=$(( (END - START) / 60 ))
    echo "[$(date)] Limit reached! Processed $PROCESSED bookmarks in ${ELAPSED}m."
    break
  fi

  COUNT=$(npx tsx src/index.ts status 2>/dev/null | grep "Pending:" | awk '{print $2}')
  if [ "$COUNT" = "0" ] || [ -z "$COUNT" ]; then
    END=$(date +%s)
    ELAPSED=$(( (END - START) / 60 ))
    echo "[$(date)] All done! Processed $PROCESSED bookmarks in ${ELAPSED}m. Failed: $FAILED"
    break
  fi

  # Adjust batch size if we're near the limit
  CURRENT_BATCH=$BATCH
  if [ "$MAX_ITEMS" -gt 0 ]; then
    REMAINING=$((MAX_ITEMS - PROCESSED))
    if [ "$REMAINING" -lt "$CURRENT_BATCH" ]; then
      CURRENT_BATCH=$REMAINING
    fi
  fi

  echo "[$(date)] Batch starting... ($COUNT pending, $PROCESSED processed so far)"
  npx tsx src/index.ts process --limit $CURRENT_BATCH 2>/dev/null
  PROCESSED=$((PROCESSED + CURRENT_BATCH))
  sleep 3
done
