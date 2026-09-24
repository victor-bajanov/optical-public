# syntax=docker/dockerfile:1.7
# Cloudflare Containers run on x86_64 Firecracker VMs. Pin platform so
# Apple Silicon builds don't accidentally ship arm64 images that run under
# slow emulation (or fail to start).
FROM --platform=linux/amd64 python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for ortools (it ships wheels, but glibc is enough)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy project metadata first for cache-friendly layering
COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir .

EXPOSE 8080
ENV PORT=8080

# uvicorn workers=1; the solver is CPU-bound and Cloudflare Container
# already handles concurrency at the routing layer.
CMD ["uvicorn", "solver.server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
