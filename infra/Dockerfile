FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false
COPY . .
RUN npm run web:build && mkdir -p /app/.media && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 3000
# No image-level HEALTHCHECK on purpose. This image runs two roles: the API (an HTTP server)
# and the worker (a poller that serves no HTTP endpoint). A single image-level check can only
# be correct for one of them, and the wrong one marks the other permanently unhealthy. Each
# compose service therefore declares the check that matches its role.
CMD ["npm", "run", "start:api"]
