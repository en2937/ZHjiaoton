FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3000 TRAFFIC_DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server-deploy/server.mjs"]
