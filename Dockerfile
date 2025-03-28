# Base for building
FROM node:22-alpine AS base
WORKDIR /app
COPY . .

# Build image for production
FROM base AS builder
RUN apk add --no-cache git python3 make g++
RUN npm install && npm run dist

# Production runtime
FROM node:22-alpine AS runner
LABEL maintainer="Vitaly Repin <vitaly.repin@gmail.com>"
RUN apk add --no-cache android-tools

COPY --from=builder /app /root/ws-scrcpy
WORKDIR /root/ws-scrcpy/dist
CMD ["npm", "start"]
