# install dependencies
FROM node:dubnium AS dependencies

WORKDIR /app

COPY package.json .
RUN npm install

# build project
FROM node:dubnium AS build-project

WORKDIR /app

COPY . .
COPY --from=dependencies /app/node_modules node_modules

RUN npm run build

# prepare to run
FROM node:dubnium-slim

WORKDIR /app
COPY --from=build-project /app/node_modules node_modules
COPY --from=build-project /app/dist .
ENV NODE_PATH .

EXPOSE 3000

CMD ["node", "main.js"]