# Scout: Node.js agent service + Ollama (free local AI) in one container.
# Build:  docker build -t scout .
# Run:    docker run -p 7860:7860 -v scout-data:/data scout
ARG OLLAMA_VERSION=0.40.6

# 1) Official Ollama runtime. Only the CPU parts are kept; the GPU libraries are ~3.5 GB
#    and free hosting has no GPU.
FROM ollama/ollama:${OLLAMA_VERSION} AS ollama
RUN rm -rf /usr/lib/ollama/cuda_* /usr/lib/ollama/rocm* /usr/lib/ollama/*cuda* /usr/lib/ollama/vulkan* \
 && ls /usr/lib/ollama >/dev/null

# 2) Scout's Node packages (production only).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 3) Final image.
FROM node:22-slim
# The AI model to bake into the image. Leave empty to download it on first start instead.
ARG PRELOAD_MODEL=hf.co/unsloth/Qwen3.5-4B-GGUF:Q4_K_M
ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/data \
    OLLAMA_BIN=/usr/bin/ollama \
    OLLAMA_MODELS=/opt/ollama-models \
    OLLAMA_NO_CLOUD=1 \
    MODEL_PROVIDER=ollama \
    MODEL_NAME=${PRELOAD_MODEL}
COPY --from=ollama /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data /opt/ollama-models && chown -R node:node /data /opt/ollama-models
# Hugging Face Spaces and most hosts run containers as user 1000 ("node" in this image).
USER node
RUN sh scripts/preload-model.sh "$PRELOAD_MODEL"
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
