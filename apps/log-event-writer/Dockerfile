FROM oven/bun:1.0
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
CMD ["bun", "run", "start"]
