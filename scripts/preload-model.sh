#!/bin/sh
# Downloads the AI model while the Docker image is built, so the running server does
# not need to download it again after every restart. Skipped when no model is given.
MODEL="$1"
if [ -z "$MODEL" ]; then
  echo "preload-model: no model given, Scout will download it on first start."
  exit 0
fi
export OLLAMA_HOST=127.0.0.1:11434
ollama serve >/tmp/ollama-build.log 2>&1 &
PID=$!
i=0
until ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "preload-model: Ollama did not start"; cat /tmp/ollama-build.log; kill "$PID"; exit 1; fi
  sleep 1
done
echo "preload-model: downloading $MODEL ..."
if ollama pull "$MODEL"; then
  echo "preload-model: done."
  STATUS=0
else
  echo "preload-model: download failed. Scout will try again when it starts."
  STATUS=0
fi
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
exit $STATUS
