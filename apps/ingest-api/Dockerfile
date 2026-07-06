FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
EXPOSE 50051
CMD ["bun", "run", "index.ts"]
