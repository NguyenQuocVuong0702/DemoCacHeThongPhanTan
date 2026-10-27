FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/coordination/package.json ./packages/coordination/package.json

RUN npm ci --workspace @smartedge/api --include-workspace-root

COPY apps/api ./apps/api
COPY packages/coordination ./packages/coordination

RUN npm run build --workspace @smartedge/api

FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/coordination/package.json ./packages/coordination/package.json

RUN npm ci --omit=dev --workspace @smartedge/api --include-workspace-root

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/coordination/dist ./packages/coordination/dist
COPY apps/api/sql ./apps/api/sql
COPY config/demo-sensors.json ./config/demo-sensors.json

WORKDIR /app/apps/api

EXPOSE 4000

CMD ["npm", "start"]
