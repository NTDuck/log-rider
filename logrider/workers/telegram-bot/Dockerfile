FROM oven/bun:1 as base
WORKDIR /usr/src/app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

CMD ["bun", "run", "index.js"]
