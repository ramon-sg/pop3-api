# Keep in sync with .tool-versions
FROM oven/bun:1.4.2

WORKDIR /app

COPY . .

RUN bun install --production --frozen-lockfile
RUN bun run build
CMD ["bun", "run", "start"]