# TokenLedger worker (ingestion + jobs)
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate
RUN pnpm deploy --filter @tokenledger/worker --prod --legacy /out

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
