FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/edge-node/package.json ./apps/edge-node/package.json

RUN npm ci --workspace @smartedge/edge-node --include-workspace-root

COPY apps/edge-node ./apps/edge-node

RUN npm run build --workspace @smartedge/edge-node

FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/edge-node/package.json ./apps/edge-node/package.json

RUN npm ci --omit=dev --workspace @smartedge/edge-node --include-workspace-root

COPY --from=build /app/apps/edge-node/dist ./apps/edge-node/dist

WORKDIR /app/apps/edge-node

EXPOSE 5001 5002 5003

CMD ["npm", "start"]
