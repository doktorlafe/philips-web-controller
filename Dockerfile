FROM node:22-alpine
WORKDIR /app
COPY server.js index.html og/og.png og/icon.png ./
USER node
CMD ["node", "server.js"]
