# TokenTrail worker (ingestion + jobs)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm deploy --filter @tokentrail/worker --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
