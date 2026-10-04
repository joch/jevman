# Build the static client with the full toolchain, then run the server on a slim Node image.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY server ./server
COPY public ./public
RUN npx vite build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG SOURCE_COMMIT=local
ENV NODE_ENV=production \
    PORT=3000 \
    SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /app
# The server uses only Node built-ins, so no node_modules ship in the runtime image.
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=1s --timeout=1s --start-period=3s --start-interval=1s --retries=2 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "server/main.ts"]
