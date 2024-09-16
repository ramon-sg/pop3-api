FROM oven/bun:latest

WORKDIR /app

COPY . .

RUN bun install --production
RUN bun run build
CMD ["bun", "run", "start"]