FROM oven/bun:1.4.2-debian

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

RUN mkdir -p data reports

CMD ["bun", "run", "chat"]
