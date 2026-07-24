# Build em multi-stage: compila TS -> dist/, roda só com deps de produção.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# O entrypoint real (api ou worker) vem do 'command' no docker-compose.
CMD ["node", "dist/api.js"]
