FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json

RUN npm ci --workspace dashboard --include-workspace-root

COPY apps/dashboard ./apps/dashboard

RUN npm run build --workspace dashboard

FROM nginx:alpine AS production

COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 80
