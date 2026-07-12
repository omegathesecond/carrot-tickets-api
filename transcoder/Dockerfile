FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=10s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["npm", "start"]
