FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src src
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist dist
EXPOSE 8080
CMD ["node", "dist/server.js"]

