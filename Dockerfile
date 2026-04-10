FROM node:22-alpine AS base

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY config ./config
COPY scripts ./scripts
COPY README.md ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

EXPOSE 3000 3001

CMD ["pnpm", "start"]
