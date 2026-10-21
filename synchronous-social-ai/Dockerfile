# Multi-stage image used for both the web and worker processes.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN useradd --uid 1001 --create-home app
COPY --from=build --chown=app /app ./
USER app
EXPOSE 3000
# Web: default. Worker: `docker run … npm run worker`. Migrations: `docker run … npm run db:migrate`.
CMD ["npm", "start"]
