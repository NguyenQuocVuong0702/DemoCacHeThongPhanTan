FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/sensor-simulator/package.json ./apps/sensor-simulator/package.json

RUN npm ci --workspace @smartedge/sensor-simulator --include-workspace-root

COPY apps/sensor-simulator ./apps/sensor-simulator

RUN npm run build --workspace @smartedge/sensor-simulator

FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/sensor-simulator/package.json ./apps/sensor-simulator/package.json

RUN npm ci --omit=dev --workspace @smartedge/sensor-simulator --include-workspace-root

COPY --from=build /app/apps/sensor-simulator/dist ./apps/sensor-simulator/dist
COPY config/demo-sensors.json ./config/demo-sensors.json

WORKDIR /app/apps/sensor-simulator

CMD ["npm", "start"]
