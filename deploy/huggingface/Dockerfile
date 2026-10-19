# Dockerfile for a Hugging Face Space. It downloads Scout's code from your (public)
# GitHub repository while building, so the Space only needs this file and README.md.
# Change these two lines to your repository and branch:
ARG REPO_URL=https://github.com/YOUR-NAME/YOUR-REPO
ARG BRANCH=main
ARG OLLAMA_VERSION=0.40.6

# Official Ollama runtime, CPU parts only (the GPU libraries are ~3.5 GB).
FROM ollama/ollama:${OLLAMA_VERSION} AS ollama
RUN rm -rf /usr/lib/ollama/cuda_* /usr/lib/ollama/rocm* /usr/lib/ollama/*cuda* /usr/lib/ollama/vulkan*

FROM node:22-slim AS source
ARG REPO_URL
ARG BRANCH
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$BRANCH" "$REPO_URL" /src

FROM node:22-slim AS deps
WORKDIR /app
COPY --from=source /src/package.json /src/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ARG PRELOAD_MODEL=hf.co/unsloth/Qwen3.5-4B-GGUF:Q4_K_M
ENV NODE_ENV=production PORT=7860 DATA_DIR=/data OLLAMA_BIN=/usr/bin/ollama \
    OLLAMA_MODELS=/opt/ollama-models OLLAMA_NO_CLOUD=1 MODEL_PROVIDER=ollama MODEL_NAME=${PRELOAD_MODEL}
COPY --from=ollama /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=source /src/package.json ./
COPY --from=source /src/src ./src
COPY --from=source /src/public ./public
COPY --from=source /src/scripts ./scripts
RUN mkdir -p /data /opt/ollama-models && chown -R node:node /data /opt/ollama-models
USER node
RUN sh scripts/preload-model.sh "$PRELOAD_MODEL"
EXPOSE 7860
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
