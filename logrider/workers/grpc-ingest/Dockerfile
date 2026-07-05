FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=builder /app /app
CMD ["bun", "run", "index.ts"]
