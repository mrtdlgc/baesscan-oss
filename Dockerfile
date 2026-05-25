FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY apps/seo/src/content ./apps/seo/src/content
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/build ./build
COPY .env.example ./
RUN mkdir -p /app/data
CMD ["node", "--no-warnings=ExperimentalWarning", "build/index.js"]
