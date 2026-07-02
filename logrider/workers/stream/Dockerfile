FROM oven/bun:1

WORKDIR /app
COPY package.json .
RUN bun install
COPY index.js .

CMD ["bun", "run", "index.js"]
